import { type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

export interface PagedRoot {
	readonly ref: ValueRef;
	readonly height: number;
	readonly size: number;
}
interface Node<T> {
	readonly key: ValueRef;
	readonly value: T;
	readonly left?: PagedRoot;
	readonly right?: PagedRoot;
}

/** Cold AVL paths live in owned storage leaves; only an operation's path is hydrated. */
export class CompactPagedTree<T> {
	readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly leavesOf: (value: T) => readonly LeafId[];
	private dirty: LeafId[] = [];
	private dirtyBytes = 0;
	private cache: Map<LeafId, { node: Node<T>; name: string }> | undefined;
	private cacheBytes = 0;
	allocatedNodes = 0;

	constructor(store: CompactContentStore, leavesOf: (value: T) => readonly LeafId[]) {
		this.store = store;
		this.values = new CompactValues(store);
		this.leavesOf = leavesOf;
	}

	adjust(root: PagedRoot | undefined, live: number, pins: number): void {
		if (root) this.store.adjust(root.ref.owner, live, pins);
	}

	/** A serial compaction round shares decoded paths, bounded to 32 KiB plus map entries. */
	async cached<R>(operation: () => Promise<R>): Promise<R> {
		this.cache = new Map();
		this.cacheBytes = 0;
		try {
			return await operation();
		} finally {
			this.cache = undefined;
			this.cacheBytes = 0;
		}
	}

	private async read(root: PagedRoot) {
		const cached = this.cache?.get(root.ref.node);
		if (cached) return cached;
		const text = await this.store.readLeaf(root.ref.node);
		const node: Node<T> = JSON.parse(text);
		const name = await this.values.read(node.key);
		if (typeof name !== "string") throw new CompactReadError("ownership");
		const decoded = { node, name };
		const bytes = (text.length + name.length) * 2 + 128;
		if (this.cache && bytes <= 32_768) {
			if (this.cacheBytes + bytes > 32_768) {
				this.cache.clear();
				this.cacheBytes = 0;
			}
			this.cache.set(root.ref.node, decoded);
			this.cacheBytes += bytes;
		}
		return decoded;
	}

	async get(root: PagedRoot | undefined, key: string): Promise<T | undefined> {
		let ref = root;
		while (ref) {
			const { node, name } = await this.read(ref);
			if (key === name) return node.value;
			ref = key < name ? node.left : node.right;
		}
		return undefined;
	}

	/** Sorted requests share each descent instead of performing one root lookup per row. */
	async getMany(root: PagedRoot | undefined, keys: readonly string[]): Promise<Map<string, T>> {
		const ordered = [...keys].sort();
		const found = new Map<string, T>();
		const visit = async (ref: PagedRoot | undefined, from: number, to: number): Promise<void> => {
			if (!ref || from === to) return;
			const { node, name } = await this.read(ref);
			let split = from;
			while (split < to && ordered[split] < name) split++;
			await visit(node.left, from, split);
			let right = split;
			while (right < to && ordered[right] === name) found.set(ordered[right++], node.value);
			await visit(node.right, right, to);
		};
		await visit(root, 0, ordered.length);
		return found;
	}

	async *entries(root: PagedRoot | undefined, after?: string): AsyncGenerator<readonly [string, T]> {
		if (!root) return;
		const { node, name: key } = await this.read(root);
		if (after === undefined || key > after) {
			yield* this.entries(node.left, after);
			yield [key, node.value];
		}
		yield* this.entries(node.right, after);
	}

	async set(root: PagedRoot | undefined, key: string, value: T | undefined): Promise<PagedRoot | undefined> {
		if (!root) {
			if (value === undefined) return undefined;
			const ref = this.values.own(key);
			try {
				return await this.make({ key: ref, value });
			} finally {
				this.store.adjust(ref.owner, -1, 0);
			}
		}
		const { node, name } = await this.read(root);
		if (key === name) {
			if (value !== undefined) return this.make({ ...node, value });
			if (!node.left || !node.right) {
				const child = node.left ?? node.right;
				this.adjust(child, 1, 0);
				return child;
			}
			let next = await this.read(node.right);
			while (next.node.left) next = await this.read(next.node.left);
			const right = await this.set(node.right, next.name, undefined);
			try {
				return await this.balance({ ...next.node, left: node.left, right });
			} finally {
				this.adjust(right, -1, 0);
			}
		}
		const side = key < name ? "left" : "right";
		const child = await this.set(node[side], key, value);
		try {
			return await this.balance({ ...node, [side]: child });
		} finally {
			this.adjust(child, -1, 0);
		}
	}

	private async make(node: Node<T>): Promise<PagedRoot> {
		// Intermediate changed paths can die before their first write; bound the draft buffer, not each update.
		if (this.dirtyBytes >= 32_768) await this.flush();
		const text = JSON.stringify(node);
		const leaf = this.store.createLeaf(text, true);
		const owner = this.store.text.own([
			leaf,
			node.key.owner,
			...this.leavesOf(node.value),
			node.left?.ref.owner ?? 0,
			node.right?.ref.owner ?? 0,
		]);
		this.store.adjust(leaf, -1, 0);
		this.dirty.push(leaf);
		this.dirtyBytes += text.length * 2;
		this.allocatedNodes++;
		return {
			ref: { node: leaf, owner },
			height: 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0),
			size: 1 + (node.left?.size ?? 0) + (node.right?.size ?? 0),
		};
	}

	async flush(): Promise<void> {
		const dirty = this.dirty;
		this.dirty = [];
		this.dirtyBytes = 0;
		for (const leaf of dirty) await this.store.flushLeaf(leaf);
	}

	private async balance(node: Node<T>): Promise<PagedRoot> {
		const leftHeavy = (node.left?.height ?? 0) > (node.right?.height ?? 0) + 1;
		const rightHeavy = (node.right?.height ?? 0) > (node.left?.height ?? 0) + 1;
		const side = leftHeavy ? "left" : "right";
		const other = leftHeavy ? "right" : "left";
		const heavy = node[side];
		if ((!leftHeavy && !rightHeavy) || !heavy) return this.make(node);
		const { node: child } = await this.read(heavy);
		const middle = child[other];
		const owned: PagedRoot[] = [];
		try {
			if (middle && middle.height > (child[side]?.height ?? 0)) {
				const { node: pivot } = await this.read(middle);
				const a = await this.make({ ...child, [other]: pivot[side] });
				owned.push(a);
				const b = await this.make({ ...node, [side]: pivot[other] });
				owned.push(b);
				return await this.make({ ...pivot, [side]: a, [other]: b });
			}
			const next = await this.make({ ...node, [side]: middle });
			owned.push(next);
			return await this.make({ ...child, [other]: next });
		} finally {
			for (const ref of owned) this.adjust(ref, -1, 0);
		}
	}
}
