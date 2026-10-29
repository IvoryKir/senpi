// Owner receipts (plan §2.4) for the manifest entries that run outside manifest-run: QA.live and QA.soak.
// The PGATE coverage lookup (consumeOwner in the gate's manifest-run.mjs) matches an owner receipt only on a
// `commands[]` row whose `manifest_id` names the entry, and counts any exit other than 0 as a failed entry. A receipt
// without that row is no coverage at all, so the harnesses write it and ownerCoverage() judges it the same way.

/** The `commands[]` row a harness receipt carries for its manifest entry; `exit` is the harness's own exit code. */
export function ownerCommand({ manifestId, kind, argv, childRuntime, exit }) {
	return { manifest_id: manifestId, kind, argv, cwd: "senpi:.", child_runtime: childRuntime, exit };
}

/** Coverage of one manifest entry by one receipt, judged as PGATE judges it: missing row, failed row, or covered. */
export function ownerCoverage(receipt, manifestId) {
	const row = (receipt?.commands ?? []).find((command) => command?.manifest_id === manifestId);
	if (!row) return { covered: false, code: "OWNER_RECEIPT_MISSING" };
	if (row.exit !== 0) return { covered: false, code: "OWNER_RECEIPT_FAILED" };
	return { covered: true, code: null };
}
