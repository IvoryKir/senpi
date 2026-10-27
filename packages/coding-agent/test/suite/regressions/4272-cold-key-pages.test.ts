import { expect, it } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: page headers must not retain a second key catalog beside exact membership.
it("pages out key lists and content while retaining exact settled membership", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: io.io });
	const index = new CompactContentIndex<{ body: string }>(store, () => [], 1);
	const key = "old-" + "x".repeat(80_000);
	const hold = io.hold("write", (path) => path.includes("/page-"));
	try {
		index.set(key, { body: "body".repeat(10_000) });
		await hold.entered;
		expect(index.has(key)).toBe(true);
		const before = index.freeze();
		hold.release();
		await store.idle();
		expect(index.has(key)).toBe(true);
		expect(index.has(key + "missing")).toBe(false);
		expect(index.pages.size).toBe(1);
		// Concrete storage census: only the explicitly retained membership tree may hold raw keys.
		for (const page of index.pages) expect(Reflect.get(page, "keys")).toBeUndefined();
		expect(store.status().structuredBytes.resident).toBe(0);
		expect(index.status().residentPages).toBe(0);
		const after = index.freeze();
		try {
			expect(await index.entries(before)).toEqual(new Map([[key, { body: "body".repeat(10_000) }]]));
			expect(await index.entries(after)).toEqual(new Map([[key, { body: "body".repeat(10_000) }]]));
			expect(index.status().residentPages).toBe(0);
			expect(index.status().peakResidentPages).toBeLessThanOrEqual(4);
		} finally {
			index.release(before);
			index.release(after);
		}
		index.patch(key, { body: "patched" });
		await store.idle();
		const patched = index.freeze();
		try {
			expect(await index.entries(patched)).toEqual(new Map([[key, { body: "patched" }]]));
		} finally {
			index.release(patched);
		}
		index.delete(key);
		await store.idle();
		expect(index.has(key)).toBe(false);
		expect(index.status().baseRows).toBe(0);
		expect(store.status().reclaimDebtBytes).toBe(0);
	} finally {
		hold.release();
		await store.retire();
		await root.cleanup();
	}
});

it("retains a removed row's paged key until the containing page is reclaimed", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: io.io });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 2);
	const key = "removed-" + "x".repeat(80_000);
	const hold = io.hold("write", (path) => path.includes("/page-"));
	try {
		index.set(key, { n: 1 });
		index.set("kept", { n: 2 });
		await hold.entered;
		index.delete(key);
		hold.release();
		await store.idle();
		index.set("next", { n: 3 });
		index.set("last", { n: 4 });
		await store.idle();
		expect(store.status().failures).toEqual([]);
		const cut = index.freeze();
		try {
			expect(await index.entries(cut)).toEqual(
				new Map([
					["kept", { n: 2 }],
					["last", { n: 4 }],
					["next", { n: 3 }],
				]),
			);
			expect(await index.lookup(cut, key)).toBeUndefined();
			expect(await index.lookup(cut, "next")).toBeDefined();
		} finally {
			index.release(cut);
		}
		expect(index.status().residentPages).toBe(0);
	} finally {
		hold.release();
		await store.retire();
		await root.cleanup();
	}
});
