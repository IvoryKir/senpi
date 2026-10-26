import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { type CompactBlockKind, CompactTransitionError } from "./compact-transition.ts";

export interface ActiveBlock {
	readonly kind: CompactBlockKind;
	root: LeafId;
	tail: string;
	units: number;
	emitted: number;
	covered: number;
	witness: string;
}

export function appendBlock(store: CompactContentStore, block: ActiveBlock, text: string): void {
	block.units += text.length;
	let rest = text;
	while (block.tail.length + rest.length >= COMPACT_LEAF_CODE_UNITS) {
		const take = COMPACT_LEAF_CODE_UNITS - block.tail.length;
		block.root = store.text.append(block.root, block.tail + rest.slice(0, take));
		block.tail = "";
		rest = rest.slice(take);
	}
	block.tail += rest;
}

/** Validate before touching the live text owner or its replay witness. */
export function deltaBlock(store: CompactContentStore, block: ActiveBlock, offset: number, text: string): void {
	if (offset !== block.emitted)
		throw new CompactTransitionError("non_contiguous", `offset ${offset}, expected ${block.emitted}`);
	const overlapEnd = Math.min(offset + text.length, block.units);
	const overlap = Math.max(0, overlapEnd - offset);
	if (overlap > 0 && text.slice(0, overlap) !== block.witness.slice(offset, overlapEnd))
		throw new CompactTransitionError("conflicting_overlap", `[${offset}, ${overlapEnd})`);
	appendBlock(store, block, text.slice(overlap));
	block.emitted = offset + text.length;
	if (block.emitted >= block.covered) block.witness = "";
}
