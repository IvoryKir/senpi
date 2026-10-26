import type { FileEntry } from "./session-manager.ts";

/** A header writer owns its queue even when compaction replaces the resident mirror. */
export interface HeaderWriteState {
	readonly kind: "writing";
	readonly file: string;
	readonly entries: FileEntry[];
}

/** Buffering cannot retain a previous file's append cursor, ownership, or torn-tail cause. */
export type SessionWriteState =
	| { readonly kind: "buffered" }
	| HeaderWriteState
	| {
			readonly kind: "flushed";
			readonly ownedHeaderFile?: string;
			pending?: { readonly entries: FileEntry[]; from: number };
			tailFailure?: { readonly cause: unknown; readonly completeBytes?: number };
	  };
