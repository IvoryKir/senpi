export const ADAPTER_KINDS = ["store", "wake", "transport", "executor", "host"] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** One conformance case: where it is implemented, which change introduced it, what it needs, and what it proves. */
export interface RegisteredCase {
	/** Unique upper-case ID, for example `STORE-01` or `KILL-STORE-01`. */
	readonly id: string;
	/** Repository-relative path of the TypeScript file that implements the case. */
	readonly impl: string;
	/** The change that introduced the case (a pull request such as `#4727`). */
	readonly intro: string;
	readonly adapters: readonly AdapterKind[];
	readonly expected: string;
}

/**
 * Every case of the durable-core conformance suite (packages/agent/docs/durable-core-adr.md). A change that adds cases
 * registers each of them here, with its mapping, in the same change.
 */
export const CONFORMANCE_REGISTRY: readonly RegisteredCase[] = [];
