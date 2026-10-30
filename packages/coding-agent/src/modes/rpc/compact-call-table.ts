import { type CallCounters, callLeaves, callOrder, type OutstandingCall } from "./compact-call-model.ts";
import { CompactComponentRoots, type ComponentRoot } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

interface Slot {
	readonly ref: ValueRef;
	readonly bytes: number;
}
interface Entry {
	call: OutstandingCall;
	readonly order: string;
}
const turnKey = (turnId: string, toolCallId: string) => `${turnId}\u0000${toolCallId}`;
const messageKey = (messageId: string, contentIndex: number) => `${messageId}#${contentIndex}`;

/**
 * The resident side of the calls component (S06 design section 2): the live entries, two indexes, the owned slot
 * values, and the persistent root every change republishes through the shared component roots.
 */
export class CompactCallTable {
	root: ComponentRoot<OutstandingCall> = { header: undefined, ref: undefined };
	private readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly roots: CompactComponentRoots<OutstandingCall>;
	private readonly entries = new Map<string, Entry>();
	private readonly byTurn = new Map<string, string>();
	private readonly byMessage = new Map<string, string>();
	private slotBytes = 0;
	private headerBytes = 0;
	readonly counters = { replacements: 0, unknown: 0, late: 0, collisions: 0, reused: 0 };

	constructor(store: CompactContentStore) {
		this.store = store;
		this.values = new CompactValues(store);
		this.roots = new CompactComponentRoots(store, callLeaves);
	}

	get(key: string): OutstandingCall | undefined {
		return this.entries.get(key)?.call;
	}

	byTurnId(turnId: string | null, toolCallId: string | null): OutstandingCall | undefined {
		if (turnId === null || !toolCallId) return undefined;
		const key = this.byTurn.get(turnKey(turnId, toolCallId));
		return key === undefined ? undefined : this.get(key);
	}

	byOwner(messageId: string, contentIndex: number): OutstandingCall | undefined {
		const key = this.byMessage.get(messageKey(messageId, contentIndex));
		return key === undefined ? undefined : this.get(key);
	}

	own(value: unknown): Slot {
		return { ref: this.values.own(value), bytes: Buffer.byteLength(JSON.stringify(value) ?? "") };
	}

	/** X07 `slotBytes` counts one copy per slot: the replaced value's bytes leave with it. */
	replaceSlot(call: OutstandingCall, field: "result", value: unknown): OutstandingCall {
		const slot = this.own(value);
		const previous = call[field];
		const next = { ...call, [field]: slot.ref };
		this.slotBytes += slot.bytes - (previous ? (this.slotBytesOf.get(previous) ?? 0) : 0);
		this.slotBytesOf.set(slot.ref, slot.bytes);
		if (previous) this.slotBytesOf.delete(previous);
		this.put(next, creationOf(call));
		this.store.adjust(slot.ref.owner, -1, 0);
		return next;
	}

	private readonly slotBytesOf = new WeakMap<ValueRef, number>();

	/** Publishes a created or changed call at its creation ordinal and refreshes every index it is reachable by. */
	put(call: OutstandingCall, creation: { readonly sequence: number; readonly k: number }): void {
		const order = callOrder(creation.sequence, creation.k);
		const previous = this.entries.get(call.runtimeItemKey)?.call;
		if (previous) this.unindex(previous);
		this.root = this.roots.set(this.root, order, call);
		this.counters.replacements++;
		this.headerBytes += headerBytes(call) - (previous ? headerBytes(previous) : 0);
		this.entries.set(call.runtimeItemKey, { call, order });
		this.index(call);
	}

	/** Whether another live call already owns this (turn, id) slot: a collision leaves the index unchanged. */
	indexedTo(turnId: string, toolCallId: string): string | undefined {
		return this.byTurn.get(turnKey(turnId, toolCallId));
	}

	/** A reused id (senpi#4278) points the (turn, id) slot at the fresh call. */
	repoint(turnId: string, toolCallId: string, key: string): void {
		this.byTurn.set(turnKey(turnId, toolCallId), key);
	}

	snapshot(): CallCounters {
		return {
			live: this.entries.size,
			replacements: this.counters.replacements,
			headerBytes: this.headerBytes,
			slotBytes: this.slotBytes,
			ignored: { unknown: this.counters.unknown, late: this.counters.late },
			collisions: this.counters.collisions,
			reused: this.counters.reused,
		};
	}

	freeze(): ValueRef | undefined {
		if (this.root.ref) this.store.adjust(this.root.ref.owner, 0, 1);
		return this.root.ref;
	}

	release(ref: ValueRef | undefined): void {
		if (ref) this.store.adjust(ref.owner, 0, -1);
	}

	entriesOf(ref: ValueRef | undefined, valid: () => void) {
		return this.roots.entries(ref, valid);
	}

	private index(call: OutstandingCall): void {
		if (call.toolCallId) {
			const slot = turnKey(call.turnId, call.toolCallId);
			if (!this.byTurn.has(slot) || this.byTurn.get(slot) === call.runtimeItemKey)
				this.byTurn.set(slot, call.runtimeItemKey);
		}
		if (call.owningMessageId !== null && call.contentIndex !== null)
			this.byMessage.set(messageKey(call.owningMessageId, call.contentIndex), call.runtimeItemKey);
	}

	private unindex(call: OutstandingCall): void {
		if (call.toolCallId) {
			const slot = turnKey(call.turnId, call.toolCallId);
			if (this.byTurn.get(slot) === call.runtimeItemKey) this.byTurn.delete(slot);
		}
		if (call.owningMessageId !== null && call.contentIndex !== null) {
			const slot = messageKey(call.owningMessageId, call.contentIndex);
			if (this.byMessage.get(slot) === call.runtimeItemKey) this.byMessage.delete(slot);
		}
	}
}

function headerBytes(call: OutstandingCall): number {
	return Buffer.byteLength(JSON.stringify(call));
}

/** The creation ordinal is fixed by the key (RULING-13 Q1): `epoch:creationSequence.k`. */
export function creationOf(call: OutstandingCall): { readonly sequence: number; readonly k: number } {
	const tail = call.runtimeItemKey.slice(call.runtimeItemKey.lastIndexOf(":") + 1);
	const [sequence, k] = tail.split(".");
	return { sequence: Number(sequence), k: Number(k) };
}
