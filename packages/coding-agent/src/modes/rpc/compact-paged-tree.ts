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
	allocatedNodes = 0;

	constructor(store: CompactContentStore, leavesOf: (value: T) => readonly LeafId[]) {
		this.store = store;
		this.values = new CompactValues(store);
		this.leavesOf = leavesOf;
	}

	adjust(root: PagedRoot | undefined, live: number, pins: number): void {
		if (root) this.store.adjust(root.ref.owner, live, pins);
	}

	private async read(root: PagedRoot): Promise<Node<T>> {
		return JSON.parse(await this.store.readLeaf(root.ref.node));
	}

	async get(root: PagedRoot | undefined, key: string): Promise<T | undefined> {
		let ref = root;
		while (ref) {
			const node = await this.read(ref);
			const name = await this.values.read(node.key);
			if (typeof name !== "string") throw new CompactReadError("ownership");
			if (key === name) return node.value;
			ref = key < name ? node.left : node.right;
		}
		return undefined;
	}

	async *entries(root: PagedRoot | undefined, after?: string): AsyncGenerator<readonly [string, T]> {
		if (!root) return;
		const node = await this.read(root);
		const key = await this.values.read(node.key);
		if (typeof key !== "string") throw new CompactReadError("ownership");
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
		const node = await this.read(root);
		const name = await this.values.read(node.key);
		if (typeof name !== "string") throw new CompactReadError("ownership");
		if (key === name) {
			if (value !== undefined) return this.make({ ...node, value });
			if (!node.left || !node.right) {
				const child = node.left ?? node.right;
				this.adjust(child, 1, 0);
				return child;
			}
			let next = await this.read(node.right);
			while (next.left) next = await this.read(next.left);
			const nextKey = await this.values.read(next.key);
			if (typeof nextKey !== "string") throw new CompactReadError("ownership");
			const right = await this.set(node.right, nextKey, undefined);
			try {
				return await this.balance({ ...next, left: node.left, right });
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
		const child = await this.read(heavy);
		const middle = child[other];
		const owned: PagedRoot[] = [];
		try {
			if (middle && middle.height > (child[side]?.height ?? 0)) {
				const pivot = await this.read(middle);
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
