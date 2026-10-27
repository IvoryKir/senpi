import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: count real leaf hydration, not elapsed time or mocked navigation.
it.each([256, 1024])("bounds hydration while compacting %i rows", async (count) => {
	const root = await spoolRoot();
	const files = new Map<string, Buffer>();
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				files.set(path, Buffer.from(data));
			},
			async readFile(path) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
	try {
		for (let n = 0; n < count; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		pause.mockRestore();
		const reads = vi.spyOn(store, "readLeaf");
		index.maybeCompact();
		await store.idle();
		const hydrations = reads.mock.calls.length;
		reads.mockRestore();
		console.info(`compaction count=${count} leafReads=${hydrations}`);
		// Includes value reads: at most two hydrations per row per binary-tree level.
		expect(hydrations).toBeLessThanOrEqual(2 * count * Math.ceil(Math.log2(count)));
		expect(index.status()).toMatchObject({ baseRows: count, overrideSlots: 0 });
		expect(store.status()).toMatchObject({ structuredBytes: { resident: 0 }, failures: [] });
		expect(index.bases["cache"]).toBeUndefined();
		const cut = index.freeze();
		try {
			expect((await index.entries(cut)).size).toBe(count);
		} finally {
			index.release(cut);
		}
	} finally {
		pause.mockRestore();
		await store.retire();
		await root.cleanup();
	}
});
