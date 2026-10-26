import type { FileEntry } from "../../core/session-manager.ts";
import {
	type PersistedBase,
	type PersistedBaseError,
	readPersistedBase,
	type TranscriptTransition,
	type TranscriptUnavailableReason,
} from "../../core/session-transcript-journal.ts";

/**
 * One immutable transcript root version: a persisted base plus the host-owned values accepted after it. `entries`
 * is shared append-only storage, read up to `count`, so a root never sees a later transition.
 */
export interface TranscriptRoot {
	readonly historyVersion: number;
	readonly leafId: string | null;
	readonly base: PersistedBase | null;
	readonly entries: readonly string[];
	readonly count: number;
	readonly unavailable: TranscriptUnavailableReason | null;
}

export type TranscriptRead =
	| { readonly ok: true; readonly entries: readonly FileEntry[] }
	| { readonly ok: false; readonly error: PersistedBaseError | TranscriptUnavailableReason };

/** The transcript component of one epoch, changed only by accepted transitions (R3.C1.1). */
export class AcceptedTranscript {
	private version = 0;
	private leafId: string | null = null;
	private base: PersistedBase | null = null;
	private entries: string[] = [];
	private unavailable: TranscriptUnavailableReason | null = null;

	get historyVersion(): number {
		return this.version;
	}

	apply(transition: TranscriptTransition): void {
		this.version += 1;
		if (transition.kind === "replace") {
			this.base = transition.base;
			this.entries = [];
			this.unavailable = null;
			return;
		}
		if (transition.kind === "unavailable") {
			this.unavailable ??= transition.reason;
			process.stderr.write(`senpi rpc acceptance: transcript component unavailable: ${transition.reason}\n`);
			return;
		}
		if (this.unavailable !== null) return;
		if (transition.kind === "append") {
			this.entries.push(transition.entry);
			this.leafId = transition.id;
		} else this.leafId = transition.leafId;
	}

	freeze(): TranscriptRoot {
		return Object.freeze({
			historyVersion: this.version,
			leafId: this.leafId,
			base: this.base,
			entries: this.entries,
			count: this.entries.length,
			unavailable: this.unavailable,
		});
	}
}

/** The root's entries: its base read only through the captured identity, then its own accepted values. */
export function readTranscriptRoot(root: TranscriptRoot): TranscriptRead {
	if (root.unavailable !== null) return { ok: false, error: root.unavailable };
	const base = root.base ? readPersistedBase(root.base) : { ok: true as const, entries: [] };
	if (!base.ok) return base;
	const accepted = root.entries.slice(0, root.count).map((entry): FileEntry => JSON.parse(entry));
	return { ok: true, entries: [...base.entries, ...accepted] };
}
