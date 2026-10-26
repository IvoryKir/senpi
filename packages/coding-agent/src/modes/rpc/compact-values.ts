import { type CompactContentStore, type LeafId, CompactWriteError } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";

export interface ValueRef {
	readonly node: LeafId;
	readonly owner: LeafId;
}
type Field = readonly [ValueRef, ValueRef];
export type ValuePage =
	| { readonly kind: "scalar"; readonly value: number | boolean | null }
	| { readonly kind: "string"; readonly text: string; readonly next?: ValueRef }
	| { readonly kind: "array"; readonly items: readonly ValueRef[]; readonly next?: ValueRef }
	| { readonly kind: "object"; readonly items: readonly Field[]; readonly next?: ValueRef };

/** Field/array descriptors and string chunks live in bounded leaves; owners share immutable subtrees. */
export class CompactValues {
	private readonly store: CompactContentStore;
	residentPages = 0;
	peakResidentPages = 0;

	constructor(store: CompactContentStore) {
		this.store = store;
	}

	record(fields: ReadonlyMap<string, ValueRef>): ValueRef {
		const entries = [...fields];
		let next: ValueRef | undefined;
		for (let end = entries.length; end > 0 || !next; end = Math.max(0, end - 128)) {
			const items: Field[] = entries
				.slice(Math.max(0, end - 128), end)
				.map(([key, value]) => [this.own(key), value]);
			const ref = this.make({ kind: "object", items, next });
			for (const [key] of items) this.store.adjust(key.owner, -1, 0);
			if (next) this.store.adjust(next.owner, -1, 0);
			next = ref;
			if (end <= 128) break;
		}
		return next;
	}

	own(value: unknown): ValueRef {
		if (typeof value === "string") {
			let next: ValueRef | undefined;
			for (let end = value.length; end > 0 || next === undefined; end = Math.max(0, end - 4096)) {
				const ref = this.make({ kind: "string", text: value.slice(Math.max(0, end - 4096), end), next });
				if (next) this.store.adjust(next.owner, -1, 0);
				next = ref;
				if (end <= 4096) break;
			}
			return next;
		}
		if (value === null || typeof value !== "object") {
			return this.make({
				kind: "scalar",
				value: typeof value === "boolean" || typeof value === "number" ? value : null,
			});
		}
		const array = Array.isArray(value);
		const entries = array ? value : Object.entries(value);
		let next: ValueRef | undefined;
		for (let end = entries.length; end > 0 || next === undefined; end = Math.max(0, end - 128)) {
			const slice = entries.slice(Math.max(0, end - 128), end);
			const items = array ? slice.map((item: unknown) => this.own(item)) : [];
			const fields: Field[] = array
				? []
				: slice.map(([key, item]: [string, unknown]) => [this.own(key), this.own(item)]);
			const ref = this.make(array ? { kind: "array", items, next } : { kind: "object", items: fields, next });
			for (const child of [...items, ...fields.flat(), ...(next ? [next] : [])])
				this.store.adjust(child.owner, -1, 0);
			next = ref;
			if (end <= 128) break;
		}
		return next;
	}

	async page(ref: ValueRef) {
		this.residentPages++;
		this.peakResidentPages = Math.max(this.peakResidentPages, this.residentPages);
		try {
			const text = await this.store.readLeaf(ref.node);
			if (Buffer.byteLength(text) > 65_536) throw new CompactReadError("size_limit");
			const page: ValuePage = JSON.parse(text);
			if ((page.kind === "object" || page.kind === "array") && page.items.length > 128)
				throw new CompactReadError("count_limit");
			return {
				value: page,
				[Symbol.dispose]: () => {
					this.residentPages--;
				},
			};
		} catch (error) {
			this.residentPages--;
			throw error;
		}
	}

	async read(ref: ValueRef): Promise<unknown> {
		using held = await this.page(ref);
		const page = held.value;
		switch (page.kind) {
			case "scalar":
				return page.value;
			case "string": {
				let result = page.text;
				let next = page.next;
				while (next) {
					using held = await this.page(next);
					const part = held.value;
					if (part.kind !== "string") throw new CompactReadError("ownership");
					result += part.text;
					next = part.next;
				}
				return result;
			}
			case "array": {
				const result: unknown[] = [];
				let current: ValueRef | undefined = ref;
				while (current) {
					using held = await this.page(current);
					const part = held.value;
					if (part.kind !== "array") throw new CompactReadError("ownership");
					for (const child of part.items) result.push(await this.read(child));
					current = part.next;
				}
				return result;
			}
			case "object": {
				const result: Record<string, unknown> = {};
				for await (const [key, value] of this.fields(ref)) {
					Object.defineProperty(result, key, {
						value: await this.read(value),
						enumerable: true,
						configurable: true,
					});
				}
				return result;
			}
		}
	}

	async *fields(ref: ValueRef): AsyncGenerator<readonly [string, ValueRef, ValueRef]> {
		let next: ValueRef | undefined = ref;
		while (next) {
			using held = await this.page(next);
			const page = held.value;
			if (page.kind !== "object") throw new CompactReadError("ownership");
			for (const [key, value] of page.items) {
				const name = await this.read(key);
				if (typeof name !== "string") throw new CompactReadError("ownership");
				yield [name, value, key];
			}
			next = page.next;
		}
	}

	/** Patches are coalesced before this call; copy descriptors, never the fields' payloads. */
	async merge(base: ValueRef, patch: ReadonlyMap<string, ValueRef>): Promise<ValueRef> {
		let reversed: ValueRef | undefined;
		let result: ValueRef | undefined;
		let buffer: Field[] = [];
		const seen = new Set<string>();
		const flush = async () => {
			const ref = this.make({ kind: "object", items: buffer, next: reversed });
			if (reversed) this.store.adjust(reversed.owner, -1, 0);
			reversed = ref;
			buffer = [];
			await this.store.flushLeaf(ref.node);
			if (!this.store.isCommitted(ref.node)) throw new CompactWriteError("storage_unavailable");
		};
		try {
			for await (const [name, value, key] of this.fields(base)) {
				if (patch.has(name)) seen.add(name);
				buffer.push([key, patch.get(name) ?? value]);
				if (buffer.length === 128) await flush();
			}
			for (const [name, value] of patch) {
				if (seen.has(name)) continue;
				const key = this.own(name);
				buffer.push([key, value]);
				// The key's initial reference is transferred to the completed page below.
				try {
					await flush();
				} finally {
					this.store.adjust(key.owner, -1, 0);
				}
			}
			if (buffer.length || !reversed) await flush();
			while (reversed) {
				using held = await this.page(reversed);
				const page = held.value;
				if (page.kind !== "object") throw new CompactReadError("ownership");
				const ref = this.make({ kind: "object", items: page.items, next: result });
				if (result) this.store.adjust(result.owner, -1, 0);
				result = ref;
				await this.store.flushLeaf(ref.node);
				if (!this.store.isCommitted(ref.node)) throw new CompactWriteError("storage_unavailable");
				const next = page.next;
				if (next) this.store.adjust(next.owner, 1, 0);
				this.store.adjust(reversed.owner, -1, 0);
				reversed = next;
			}
			if (!result) throw new CompactReadError("ownership");
			return result;
		} catch (error) {
			if (reversed) this.store.adjust(reversed.owner, -1, 0);
			if (result) this.store.adjust(result.owner, -1, 0);
			throw error;
		}
	}

	private make(page: ValuePage): ValueRef {
		const children = page.kind === "object" ? page.items.flat() : page.kind === "array" ? [...page.items] : [];
		if (page.kind !== "scalar" && page.next) children.push(page.next);
		const node = this.store.createLeaf(JSON.stringify(page), true);
		const owner = this.store.text.own([node, ...children.map((ref) => ref.owner)]);
		this.store.adjust(node, -1, 0);
		return { node, owner };
	}
}
