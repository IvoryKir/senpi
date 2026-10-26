import type { CompactContentIndex, IndexOverride, IndexPage, IndexRow } from "./compact-content-index.ts";
import { packPages } from "./compact-index-pages.ts";
import { CompactReadError } from "./compact-read-lease.ts";

type Index = Pick<
	CompactContentIndex<object>,
	| "store"
	| "values"
	| "bases"
	| "overlays"
	| "base"
	| "overrides"
	| "pages"
	| "pending"
	| "residentPages"
	| "peakResidentPages"
	| "readPage"
	| "freeze"
	| "release"
	| "drop"
>;

/** One bounded selection and one optional small page, with a single atomic representation swap. */
export class CompactIndexCompactor {
	private readonly index: Index;
	private readonly threshold: number;
	private running = false;

	constructor(index: Index, threshold: number) {
		this.index = index;
		this.threshold = threshold;
	}

	schedule(): void {
		const index = this.index;
		if (
			this.running ||
			!index.store.spillAllowed ||
			(index.overrides?.size ?? 0) - index.pending.size < this.threshold
		)
			return;
		this.running = true;
		index.store.enqueue("page_write", async () => {
			let progress = false;
			try {
				progress = await this.compact();
			} finally {
				this.running = false;
			}
			if (progress) this.schedule();
		});
	}

	private async compact(): Promise<boolean> {
		const i = this.index;
		if (!i.store.spillAllowed) return false;
		const cut = i.freeze();
		const selected = new Map<string, IndexOverride>();
		let touched: IndexPage | undefined;
		for (const [key, value] of i.overlays.entries(cut.overrides)) {
			const page = i.bases.get(cut.base, key)?.page;
			if (!i.pending.has(key) && (!page || !touched || page === touched)) {
				selected.set(key, value);
				touched ??= page;
			}
			if (selected.size === 128) break;
		}
		const rows = new Map<string, IndexRow>();
		const removed = new Set<string>();
		const merged: number[] = [];
		const written: IndexPage[] = [];
		const loaded: Awaited<ReturnType<Index["readPage"]>>[] = [];
		let published = false;
		try {
			let small: IndexPage | undefined;
			for (const page of i.pages) {
				if (page.keys.length < 64 && page.bytes < 32_768) {
					small = page;
					break;
				}
			}
			for (const page of new Set([small, touched])) {
				if (!page) continue;
				const data = await i.readPage(page);
				loaded.push(data);
				for (const [offset, key] of page.keys.entries()) {
					if (i.bases.get(cut.base, key)?.page === page) {
						rows.set(key, data.rows[offset]);
						removed.add(key);
					}
				}
			}
			for (const [key, change] of selected) {
				removed.add(key);
				if (change.deleted) {
					rows.delete(key);
					continue;
				}
				let row = change.row ?? rows.get(key);
				if (row && change.patch.size) {
					const value = await i.values.merge(row.value, change.patch);
					merged.push(value.owner);
					row = { ...row, value };
				}
				if (row) rows.set(key, row);
			}
			const ordered = [...rows];
			let offset = 0;
			for (const chunk of packPages(ordered.map(([, row]) => row))) {
				const data = Buffer.from(JSON.stringify(chunk));
				i.peakResidentPages = Math.max(i.peakResidentPages, i.residentPages + 1);
				const path = await i.store.writeFile(data, "page_write", data.byteLength);
				if (path === undefined) return false;
				written.push({
					path,
					bytes: data.byteLength,
					keys: ordered.slice(offset, offset + chunk.length).map(([key]) => key),
					owner: 0,
					live: 0,
					pins: 0,
				});
				offset += chunk.length;
			}
			if (!i.store.spillAllowed) return false;
			for (const key of removed) {
				const next = i.bases.set(i.base, key, undefined);
				i.bases.adjust(i.base, -1, 0);
				i.base = next;
			}
			for (const candidate of written) {
				const kept: [string, number][] = [];
				const refs: number[] = [];
				for (const [offset, key] of candidate.keys.entries()) {
					const folded = selected.get(key);
					const current = i.overlays.get(i.overrides, key);
					if (folded && current !== folded && (!current || current.deleted || current.row !== folded.row))
						continue;
					const row = rows.get(key);
					if (!row) throw new CompactReadError("ownership");
					refs.push(row.key.owner, row.value.owner, row.payload);
					kept.push([key, offset]);
				}
				const page = { ...candidate, owner: i.store.text.own(refs) };
				for (const [key, offset] of kept) {
					const next = i.bases.set(i.base, key, { page, offset });
					i.bases.adjust(i.base, -1, 0);
					i.base = next;
				}
				i.store.adjust(page.owner, -1, 0);
				if (page.live === 0) i.store.discard(page.path, page.bytes);
			}
			for (const [key, value] of selected) {
				const current = i.overlays.get(i.overrides, key);
				if (current === value || (current?.deleted && !i.bases.get(i.base, key))) i.drop(key);
			}
			published = true;
			return selected.size > 0;
		} finally {
			for (const page of loaded) page[Symbol.dispose]();
			for (const page of written) {
				if (!published) i.store.discard(page.path, page.bytes);
			}
			for (const owner of merged) i.store.adjust(owner, -1, 0);
			i.release(cut);
		}
	}
}
