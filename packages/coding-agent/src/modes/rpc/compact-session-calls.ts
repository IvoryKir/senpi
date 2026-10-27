import {
	type CallCorrelation,
	type CallRaw,
	type CallScope,
	type FrozenCalls,
	type OutstandingCall,
	runtimeItemKey,
	TERMINAL_PHASE,
	terminal,
} from "./compact-call-model.ts";
import { CompactCallTable, creationOf } from "./compact-call-table.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { ValueRef } from "./compact-values.ts";

export interface CallStep {
	readonly sequence: number;
	readonly scope: CallScope;
}
export interface AnnouncedBlock {
	readonly messageId: string;
	readonly contentIndex: number;
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly resolvedName?: string;
	readonly correlation?: CallCorrelation;
}
export interface ExecutionStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

const FRESH = {
	owningMessageId: null,
	contentIndex: null,
	startSequence: null,
	startedAtMs: null,
	requestedName: null,
	resolvedName: null,
	seed: null,
	raw: null,
	input: { announced: null, started: null, prepared: null },
	correlation: null,
	result: null,
	outcome: null,
} as const;

/**
 * The outstanding-call phase machine (R3.C3.1-C3.3, RULING-13): one reducer, phases only forward, records in any
 * order, a host-minted key fixed at creation. Every change republishes the calls root at the lane sequence given.
 */
export class CompactSessionCalls {
	readonly table: CompactCallTable;
	sequence = 0;
	private mintedAt = -1;
	private mintedK = 0;

	constructor(store: CompactContentStore) {
		this.table = new CompactCallTable(store);
	}

	get(key: string): OutstandingCall | undefined {
		return this.table.get(key);
	}

	/**
	 * `toolcall_start`: a bridge-started call joins by id and, like a fresh one, reads its raw prefix through the active
	 * block until its end (C3 cond. 3); an owned slot with the same id is a collision.
	 */
	toolStart(step: CallStep, block: AnnouncedBlock): void {
		const turnId = step.scope.turnId;
		if (turnId === null) return;
		const id = block.id || null;
		const existing = this.table.byTurnId(turnId, id);
		const raw: CallRaw = { kind: "active", messageId: block.messageId, contentIndex: block.contentIndex };
		const fields = {
			owningMessageId: block.messageId,
			contentIndex: block.contentIndex,
			seed: block.arguments,
			raw,
			...(block.correlation ? { correlation: block.correlation } : {}),
		};
		if (existing && existing.owningMessageId === null) {
			this.update(step, existing, { ...fields, requestedName: existing.requestedName ?? block.name });
			return;
		}
		if (existing) this.table.counters.collisions++;
		this.create(step, {
			turnId,
			toolCallId: id,
			phase: "streaming",
			requestedName: block.name || null,
			resolvedName: block.resolvedName ?? null,
			...fields,
		});
	}

	requestedName(step: CallStep, messageId: string, contentIndex: number, name: string): void {
		const call = this.table.byOwner(messageId, contentIndex);
		if (call) this.update(step, call, { requestedName: name });
	}

	/** `toolcall_end` and each terminal block: the announcement's final id, name and input; the call owns the raw. */
	announce(step: CallStep, block: AnnouncedBlock, raw: CallRaw | null): void {
		const call = this.table.byOwner(block.messageId, block.contentIndex);
		const turnId = step.scope.turnId;
		if (!call) {
			if (turnId === null) return;
			this.create(step, {
				turnId,
				toolCallId: block.id || null,
				owningMessageId: block.messageId,
				contentIndex: block.contentIndex,
				phase: "awaiting-execution",
				requestedName: block.name || null,
				resolvedName: block.resolvedName ?? null,
				raw,
				input: { announced: block.arguments, started: null, prepared: null },
				...(block.correlation ? { correlation: block.correlation } : {}),
			});
			return;
		}
		const id = block.id || null;
		const taken = id && id !== call.toolCallId ? this.table.indexedTo(call.turnId, id) : undefined;
		if (taken !== undefined) this.table.counters.collisions++;
		this.update(step, call, {
			...(taken === undefined && id ? { toolCallId: id } : {}),
			phase: call.phase === "streaming" ? "awaiting-execution" : call.phase,
			requestedName: block.name || call.requestedName,
			resolvedName: block.resolvedName ?? call.resolvedName,
			input: { ...call.input, announced: block.arguments },
			raw: call.raw?.kind === "owned" ? call.raw : raw,
		});
	}

	executionStart(step: CallStep, start: ExecutionStart): void {
		const turnId = step.scope.turnId;
		if (turnId === null) return;
		const existing = this.table.byTurnId(turnId, start.toolCallId);
		const started = {
			startSequence: step.sequence,
			startedAtMs: Date.now(),
			resolvedName: start.toolName,
		};
		if (existing && existing.startSequence === null && !terminal(existing)) {
			this.update(step, existing, {
				...started,
				phase: "executing",
				input: { ...existing.input, started: start.args },
			});
			return;
		}
		if (existing) this.table.counters.reused++;
		const created = this.create(step, {
			turnId,
			toolCallId: start.toolCallId,
			phase: "executing",
			input: { announced: null, started: start.args, prepared: null },
			...started,
		});
		if (existing) this.table.repoint(turnId, start.toolCallId, created.runtimeItemKey);
	}

	executionEnd(step: CallStep, toolCallId: string, result: unknown, isError: boolean): void {
		const call = this.table.byTurnId(step.scope.turnId, toolCallId);
		if (!call) return this.ignore("unknown");
		if (terminal(call)) return this.ignore("late");
		const ended = this.table.replaceSlot(call, "result", result);
		this.update(step, ended, {
			phase: TERMINAL_PHASE,
			outcome: { kind: "result", isError, source: "execution_end" },
		});
	}

	freeze(): FrozenCalls {
		return { sequence: this.sequence, ref: this.table.freeze(), counters: this.table.snapshot() };
	}

	release(frozen: FrozenCalls): void {
		this.table.release(frozen.ref);
	}

	entries(ref: ValueRef | undefined, valid: () => void) {
		return this.table.entriesOf(ref, valid);
	}

	private ignore(kind: "unknown" | "late"): void {
		this.table.counters[kind]++;
	}

	private create(step: CallStep, fields: Partial<OutstandingCall> & Pick<OutstandingCall, "turnId" | "phase">) {
		if (this.mintedAt !== step.sequence) {
			this.mintedAt = step.sequence;
			this.mintedK = 0;
		} else this.mintedK++;
		const call: OutstandingCall = {
			...FRESH,
			toolCallId: null,
			...fields,
			runtimeItemKey: runtimeItemKey(step.scope, step.sequence, this.mintedK),
		};
		this.table.put(call, { sequence: step.sequence, k: this.mintedK });
		this.sequence = step.sequence;
		return call;
	}

	private update(step: CallStep, call: OutstandingCall, patch: Partial<OutstandingCall>): void {
		this.table.put({ ...call, ...patch }, creationOf(call));
		this.sequence = step.sequence;
	}
}
