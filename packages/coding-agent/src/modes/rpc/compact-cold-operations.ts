import type { CompactContentIndex } from "./compact-content-index.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CompactPersistence, CompactTransition } from "./compact-transition.ts";

export type CompactColdOperation = Extract<CompactTransition, { type: "message_status" | "message_remove" }>;
export type CompactColdOutcome =
	| { readonly kind: "applied"; readonly afterSequence: number }
	| {
			readonly kind: "rejected";
			readonly afterSequence: number;
			readonly reason: "unknown_message" | "capacity" | "retired";
	  }
	| { readonly kind: "failed"; readonly afterSequence: number; readonly cause: unknown };

type Index = Pick<
	CompactContentIndex<{ readonly persistence: CompactPersistence }>,
	"store" | "freeze" | "lookup" | "patch" | "delete" | "release"
>;
/** Non-acceptance FIFO. Capacity rejection leaves work unqueued; callers await admitted operations. */
export class CompactColdOperations {
	private chain: Promise<void> = Promise.resolve();
	private readonly keys = new Map<string, { removed: boolean; pending: number }>();
	private pending = 0;
	private readonly index: Index;
	constructor(index: Index) {
		this.index = index;
	}

	run(input: CompactColdOperation, afterSequence: number): Promise<CompactColdOutcome> {
		const operation = { ...input };
		const key = operation.messageId;
		// Bound queued roots, keys and closures independently of the settled membership catalog.
		if (this.pending === 128) return Promise.resolve({ kind: "rejected", reason: "capacity", afterSequence });
		const token = this.keys.get(key) ?? { removed: false, pending: 0 };
		this.keys.set(key, token);
		token.pending++;
		this.pending++;
		const result = this.chain.then(async (): Promise<CompactColdOutcome> => {
			try {
				this.index.store.assertReadable();
				if (token.removed) return { kind: "rejected", reason: "unknown_message", afterSequence };
				const cut = this.index.freeze();
				try {
					if (!(await this.index.lookup(cut, key)))
						return { kind: "rejected", reason: "unknown_message", afterSequence };
					this.index.store.assertReadable();
					if (operation.type === "message_status") this.index.patch(key, { persistence: operation.persistence });
					else {
						this.index.delete(key);
						token.removed = true;
						this.keys.delete(key);
					}
					return { kind: "applied", afterSequence };
				} finally {
					this.index.release(cut);
				}
			} catch (cause) {
				return cause instanceof CompactReadError && cause.reason === "retired"
					? { kind: "rejected", reason: "retired", afterSequence }
					: { kind: "failed", cause, afterSequence };
			} finally {
				this.pending--;
				if (--token.pending === 0 && this.keys.get(key) === token) this.keys.delete(key);
			}
		});
		this.chain = result.then(() => undefined);
		return result;
	}

	idle(): Promise<void> {
		return this.chain;
	}
}
