import { serializeJsonLine } from "./jsonl.ts";
import { FrozenFramesCursor, type LegacyViewCursor } from "./legacy-view-cursor.ts";
import { carriesMedia, omitNormalInlineMedia } from "./media-placeholders.ts";
import type { ResyncReason, RpcSessionResyncRequired } from "./socket-peer-recovery.ts";

/**
 * A replayable snapshot line.
 *
 * `placeholderLine` is the `media_placeholders` variant. The writer supplies it only when
 * a capable connection was already attached when the record was emitted; a connection that
 * attaches later still needs it, so the frozen line supplies the source on the first
 * capable replay. Only the derived line is memoized; no provider object is retained.
 * `mayCarryMedia` is the type gate taken at acceptance: a record whose type cannot carry
 * media (every `message_update` partial) replays its `line` with no parse at all; only
 * media-bearing records parse their frozen line, once.
 */
type SnapshotRecord = {
	readonly line: string;
	placeholderLine?: string;
	readonly hasMessage: boolean;
	readonly mayCarryMedia: boolean;
};

/** The placeholder variant of a remembered record, derived and memoized on first use. */
function snapshotPlaceholderLine(record: SnapshotRecord): string {
	if (record.placeholderLine !== undefined) return record.placeholderLine;
	if (!record.mayCarryMedia) return record.line;
	const source = JSON.parse(record.line) as Record<string, unknown>;
	const redacted = omitNormalInlineMedia(source);
	record.placeholderLine = redacted === source ? record.line : serializeJsonLine(redacted);
	return record.placeholderLine;
}

/** The legacy frames a cut is read in: lifecycle, the active message's records, then the open questions. */
export interface FrozenAttachView {
	readonly placeholders: boolean;
	readonly now: number;
	readonly onRelease: () => void;
}

export interface FrozenResyncView {
	readonly sessions: readonly string[];
	readonly reason: ResyncReason;
	readonly placeholders: boolean;
	/** Read when the frame is written: whether the peer still holds the session then (`closed` otherwise). */
	readonly closedNow: (sessionId: string) => boolean;
	readonly onRelease: () => void;
}

/**
 * The retained per-session replay source a late peer's baseline is frozen from (S07a): today's lifecycle line,
 * the active message's non-targeted lines and the open broadcast questions. Freezing takes refs and a length,
 * never a copy of the lines; S07b replaces this source with the compact current-state view and deletes it.
 */
export class LegacyReplayStore {
	private readonly sessionSnapshots = new Map<string, SnapshotRecord[]>();
	private readonly lifecycleSnapshots = new Map<string, SnapshotRecord>();
	private readonly pendingQuestions = new Map<string, Map<string, Record<string, unknown>>>();
	private cursors = 0;

	/** Frozen views not yet released: zero once every barrier ended. */
	get openCursors(): number {
		return this.cursors;
	}

	pendingQuestionCount(sessionId: string): number {
		return this.pendingQuestions.get(sessionId)?.size ?? 0;
	}

	remember(sessionId: string, value: Record<string, unknown>, line: string, placeholderLine?: string): void {
		const record: SnapshotRecord = {
			line,
			placeholderLine,
			hasMessage: value.message != null,
			mayCarryMedia: carriesMedia(value),
		};
		if (value.type === "session_lifecycle") {
			this.lifecycleSnapshots.set(sessionId, record);
			return;
		}
		if (value.type === "extension_ui_request" && value.method === "question" && typeof value.id === "string") {
			const pending = this.pendingQuestions.get(sessionId) ?? new Map<string, Record<string, unknown>>();
			// Writer acceptance already detached and JSON-normalized the frame.
			pending.set(value.id, { ...value });
			this.pendingQuestions.set(sessionId, pending);
			return;
		}
		if (value.type === "question_resolved" && typeof value.id === "string") {
			this.pendingQuestions.get(sessionId)?.delete(value.id);
			return;
		}
		if (value.type === "question_updated" && typeof value.id === "string") {
			const frame = this.pendingQuestions.get(sessionId)?.get(value.id);
			if (frame) Object.assign(frame, { deadlineAtMs: value.deadlineAtMs, remainingMs: value.remainingMs });
			return;
		}
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		if (value.type === "message_start" || (value.type === "message_update" && event?.type === "text_start")) {
			this.sessionSnapshots.set(sessionId, [record]);
		} else if (this.sessionSnapshots.has(sessionId)) {
			this.sessionSnapshots.get(sessionId)?.push(record);
		}
		if (value.type === "message_end") this.sessionSnapshots.delete(sessionId);
	}

	forget(sessionId: string): void {
		this.pendingQuestions.delete(sessionId);
		this.sessionSnapshots.delete(sessionId);
		this.lifecycleSnapshots.delete(sessionId);
	}

	/** A late peer's baseline, frozen now: the array ref and its length, the question frames at this clock. */
	freezeAttach(sessionId: string, view: FrozenAttachView): LegacyViewCursor {
		const lifecycle = this.lifecycleSnapshots.get(sessionId);
		const records = this.sessionSnapshots.get(sessionId) ?? [];
		const length = records.length;
		const head = lifecycle === undefined ? 0 : 1;
		const questions = [...(this.pendingQuestions.get(sessionId)?.values() ?? [])].map((frame) =>
			serializeJsonLine({
				...frame,
				remainingMs: typeof frame.deadlineAtMs === "number" ? Math.max(0, frame.deadlineAtMs - view.now) : 0,
			}),
		);
		const variant = (record: SnapshotRecord) => (view.placeholders ? snapshotPlaceholderLine(record) : record.line);
		return this.open(
			head + length + questions.length,
			(index) => {
				if (lifecycle !== undefined && index === 0) return variant(lifecycle);
				const at = index - head;
				if (at < length) return variant(records[at]);
				return questions[at - length];
			},
			view.onRelease,
		);
	}

	/** A shed's recovery cut, frozen now: per attached session, the latest retained record that carries a message. */
	freezeResync(view: FrozenResyncView): LegacyViewCursor {
		const latest = view.sessions.map((sessionId) => ({
			sessionId,
			record: this.sessionSnapshots.get(sessionId)?.findLast((record) => record.hasMessage),
		}));
		return this.open(
			latest.length,
			(index) => {
				const { sessionId, record } = latest[index];
				// The producer may mutate its partial object after emission. The serialized
				// record, not that object, fixes the recovery cut before later deltas enqueue.
				const frozen: unknown = record === undefined ? undefined : JSON.parse(record.line);
				const resync: RpcSessionResyncRequired = {
					type: "resync_required",
					sessionId,
					reason: view.reason,
					message: typeof frozen === "object" && frozen !== null && "message" in frozen ? frozen.message : null,
					...(view.closedNow(sessionId) ? { closed: true as const } : {}),
				};
				return serializeJsonLine(view.placeholders ? omitNormalInlineMedia(resync) : resync);
			},
			view.onRelease,
		);
	}

	private open(count: number, frame: (index: number) => string, onRelease: () => void): LegacyViewCursor {
		this.cursors += 1;
		return new FrozenFramesCursor(count, frame, () => {
			this.cursors -= 1;
			onRelease();
		});
	}
}
