import { serializeJsonLine } from "./jsonl.ts";
import { type FrozenFrames, FrozenFramesCursor, type LegacyViewCursor } from "./legacy-view-cursor.ts";
import { observeLifecycleDelivery } from "./lifecycle-delivery.ts";
import { carriesMedia, omitNormalInlineMedia } from "./media-placeholders.ts";
import type { ResyncCut, ResyncReason, RpcSessionResyncRequired } from "./socket-peer-recovery.ts";

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
	readonly reason: ResyncReason;
	readonly placeholders: boolean;
	/** Read when the cut is read: whether the peer still holds the session then (`closed` otherwise). */
	readonly closedNow: (sessionId: string) => boolean;
	readonly onRelease: () => void;
}

/** One session's line of a resync cut; a session without a record resumes nothing (`message: null`). */
type ResyncEntry = {
	readonly sessionId: string;
	readonly record: SnapshotRecord | undefined;
	readonly closed: boolean;
};

function resyncFrame(entry: ResyncEntry, view: FrozenResyncView): string {
	// The producer may mutate its partial object after emission. The serialized
	// record, not that object, fixes the recovery cut before later deltas enqueue.
	const frozen: unknown = entry.record === undefined ? undefined : JSON.parse(entry.record.line);
	const resync: RpcSessionResyncRequired = {
		type: "resync_required",
		sessionId: entry.sessionId,
		reason: view.reason,
		message: typeof frozen === "object" && frozen !== null && "message" in frozen ? frozen.message : null,
		...(entry.closed ? { closed: true as const } : {}),
	};
	return serializeJsonLine(view.placeholders ? omitNormalInlineMedia(resync) : resync);
}

class ResyncCursor extends FrozenFramesCursor implements ResyncCut {
	readonly sessions: readonly string[];

	constructor(sessions: readonly string[], source: () => FrozenFrames, onRelease: () => void) {
		super(source, onRelease);
		this.sessions = sessions;
	}
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
		const frames: FrozenFrames = {
			count: head + length + questions.length,
			frame: (index) => {
				if (lifecycle !== undefined && index === 0)
					return serializeJsonLine(observeLifecycleDelivery(JSON.parse(lifecycle.line)));
				const at = index - head;
				if (at < length) return variant(records[at]);
				return questions[at - length];
			},
		};
		return new FrozenFramesCursor(() => frames, this.closing(view.onRelease));
	}

	/**
	 * A shed's cut frozen at the shed (the compact-updates path): per session the latest retained record that carries
	 * a message, read with `closed` as of the read; a session the peer no longer holds resumes nothing.
	 */
	freezeResync(sessions: readonly string[], view: FrozenResyncView): ResyncCut {
		const latest = sessions.map((sessionId) => ({ sessionId, record: this.latestMessage(sessionId) }));
		return this.openResync(
			sessions,
			() =>
				latest.map(({ sessionId, record }) => {
					const closed = view.closedNow(sessionId);
					return { sessionId, closed, record: closed ? undefined : record };
				}),
			view,
		);
	}

	/**
	 * Today's drain-time cut (the compact-updates flag off), read when the gap is delivered: the sessions held at
	 * the shed and those held then, each with its latest retained record at that moment.
	 */
	deferResync(sessions: readonly string[], heldNow: () => readonly string[], view: FrozenResyncView): ResyncCut {
		return this.openResync(
			sessions,
			() =>
				[...new Set([...sessions, ...heldNow()])].map((sessionId) => ({
					sessionId,
					closed: view.closedNow(sessionId),
					record: this.latestMessage(sessionId),
				})),
			view,
		);
	}

	private latestMessage(sessionId: string): SnapshotRecord | undefined {
		return this.sessionSnapshots.get(sessionId)?.findLast((record) => record.hasMessage);
	}

	private openResync(
		sessions: readonly string[],
		entries: () => readonly ResyncEntry[],
		view: FrozenResyncView,
	): ResyncCut {
		return new ResyncCursor(
			sessions,
			() => {
				const frozen = entries();
				return { count: frozen.length, frame: (index) => resyncFrame(frozen[index], view) };
			},
			this.closing(view.onRelease),
		);
	}

	/** Counts the view open until its release runs once. */
	private closing(onRelease: () => void): () => void {
		this.cursors += 1;
		return () => {
			this.cursors -= 1;
			onRelease();
		};
	}
}
