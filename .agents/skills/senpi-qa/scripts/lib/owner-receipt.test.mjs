// node --test .agents/skills/senpi-qa/scripts/lib/owner-receipt.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { ownerCommand, ownerCoverage } from "./owner-receipt.mjs";

const row = (manifestId, exit) =>
	ownerCommand({ manifestId, kind: manifestId === "QA.live" ? "live" : "soak", argv: ["node", "x.mjs"], childRuntime: "bun", exit });

for (const id of ["QA.live", "QA.soak"]) {
	test(`${id}: a receipt without a commands[].manifest_id row is not coverage`, () => {
		const shapes = [
			{},
			{ commands: [] },
			{ manifest_id: id, kind: "soak", exit: 0 },
			{ commands: [{ kind: "live", exit: 0 }] },
			{ commands: [row(id === "QA.live" ? "QA.soak" : "QA.live", 0)] },
		];
		for (const receipt of shapes) assert.deepEqual(ownerCoverage(receipt, id), { covered: false, code: "OWNER_RECEIPT_MISSING" });
	});

	test(`${id}: the harness row covers the entry only when the run exited 0`, () => {
		assert.deepEqual(ownerCoverage({ commands: [row(id, 0)] }, id), { covered: true, code: null });
		for (const exit of [1, 2, null])
			assert.deepEqual(ownerCoverage({ commands: [row(id, exit)] }, id), { covered: false, code: "OWNER_RECEIPT_FAILED" });
	});
}

test("ownerCommand writes the row fields the coverage lookup and the receipt checker read", () => {
	assert.deepEqual(row("QA.soak", 0), {
		manifest_id: "QA.soak",
		kind: "soak",
		argv: ["node", "x.mjs"],
		cwd: "senpi:.",
		child_runtime: "bun",
		exit: 0,
	});
});
