import type { CompactContentIndex, FrozenIndex, IndexCursor } from "./compact-content-index.ts";
import { CompactReadError } from "./compact-read-lease.ts";

/** Compatibility assembly runs under the index's operation lease; recovery consumes descriptors. */
export async function readIndexEntries<Row extends object>(
	index: Pick<CompactContentIndex<Row>, "page" | "values">,
	cut: FrozenIndex,
): Promise<Map<string, Row>> {
	const result = new Map<string, Row>();
	let after: IndexCursor | undefined;
	for (;;) {
		const page = await index.page(cut, after);
		for (const entry of page.rows) {
			const value = await index.values.read(entry.row.value);
			const row: Row = JSON.parse(JSON.stringify(value));
			if (entry.patch) Object.assign(row, await index.values.read(entry.patch));
			const key = await index.values.read(entry.row.key);
			if (typeof key !== "string") throw new CompactReadError("ownership");
			result.set(key, row);
		}
		if (!page.next) return result;
		after = page.next;
	}
}
