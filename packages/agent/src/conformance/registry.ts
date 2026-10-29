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
const STORE_CASES_IMPL = "packages/agent/src/durable/testing/store-cases.ts";
const KILL_STORE_IMPL = "packages/agent/src/durable/testing/kill-store.ts";
const storeCase = (id: string, impl: string, expected: string): RegisteredCase => ({
	id,
	impl,
	intro: "#4730",
	adapters: ["store"],
	expected,
});

export const CONFORMANCE_REGISTRY: readonly RegisteredCase[] = [
	storeCase(
		"STORE-01",
		STORE_CASES_IMPL,
		"a commit adopts once, after its batch is durable; every instance sees each batch whole",
	),
	storeCase(
		"STORE-02",
		STORE_CASES_IMPL,
		"a cut at every write point of a commit leaves nothing of it durable, with no adopt and no seq burned",
	),
	storeCase(
		"STORE-03",
		STORE_CASES_IMPL,
		"concurrent admissions run one at a time in admission order; a refused mutation releases the line",
	),
	storeCase(
		"STORE-04",
		STORE_CASES_IMPL,
		"an old owner's delayed commit or claim after the new owner's first commit is refused and changes nothing",
	),
	storeCase(
		"STORE-05",
		STORE_CASES_IMPL,
		"claim + import across hosts is whole, idempotent and tail-only; a diverged log is refused atomically",
	),
	storeCase(
		"STORE-06",
		STORE_CASES_IMPL,
		"minted IDs are unique; record and document scans, deletes and duplicate-ID refusal behave as specified",
	),
	storeCase(
		"STORE-07",
		STORE_CASES_IMPL,
		"a claim raises the epoch by exactly one; a claim that skips an epoch is refused and changes nothing",
	),
	storeCase(
		"KILL-STORE-01",
		KILL_STORE_IMPL,
		"everywhere: kill before a commit; after restart nothing is durable and the batch commits with the same IDs",
	),
	storeCase(
		"KILL-STORE-02",
		KILL_STORE_IMPL,
		"everywhere: kill after a commit is durable; after restart it is whole, stable IDs, and a retry applies nothing",
	),
	storeCase(
		"KILL-STORE-03",
		KILL_STORE_IMPL,
		"everywhere: kill before a claim; after restart the epoch is unchanged and the claim succeeds",
	),
	storeCase(
		"KILL-STORE-04",
		KILL_STORE_IMPL,
		"everywhere: kill after a claim is durable; after restart the new epoch holds and the old one is fenced",
	),
	storeCase(
		"KILL-STORE-05",
		KILL_STORE_IMPL,
		"everywhere: kill before an import; after restart nothing is imported and the import succeeds",
	),
	storeCase(
		"KILL-STORE-06",
		KILL_STORE_IMPL,
		"everywhere: kill after an import is durable; after restart it is whole and a re-import adds nothing",
	),
];
