import { expect, it } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / #4378 LOW: equal heights do not imply a full right subtree.
// Inspect the existing private height rather than adding a production API just for this invariant.
it("keeps append-tree height logarithmic at 1,024 and 1,048,576 real leaves", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, spillAboveBytes: Number.POSITIVE_INFINITY });
	let ref = 0;
	try {
		for (let count = 1; count <= 2 ** 20; count++) {
			ref = store.text.append(ref, "x");
			if (count === 1024 || count === 2 ** 20) {
				expect
					.soft(store.text["height"](ref), `${count} leaves`)
					.toBeLessThanOrEqual(Math.ceil(Math.log2(count)) + 1);
				expect(store.text.units(ref)).toBe(count);
				expect(store.text.residentNodes).toBe(count - 1);
			}
		}
		expect(await store.text.read(ref, "", 2 ** 20 - 1, 1, 1)).toBe("x");
	} finally {
		store.adjust(ref, -1, 0);
		await store.retire();
		await root.cleanup();
	}
	expect(store.text.residentNodes).toBe(0);
	expect(store.status().residentPayloadBytes).toBe(0);
}, 300_000);
