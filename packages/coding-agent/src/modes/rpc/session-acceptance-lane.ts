import { randomUUID } from "node:crypto";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";

/** Where one accepted recovery record sits in its runtime incarnation (R3.C1.1). */
interface AcceptedRef {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly messageId: string | null;
	readonly turnId: string | null;
}

/** Accepted transcript appends since bootstrap: `entries` is shared append-only storage, read up to `count`. */
interface TranscriptRoot {
	readonly historyVersion: number;
	readonly leafId: string | null;
	readonly entries: readonly string[];
	readonly count: number;
}

interface AcceptedCorrelation {
	readonly sequence: number;
	readonly clientMessageId: unknown;
	readonly clientTurnId: unknown;
	readonly clientMessages: unknown;
}

export interface FrozenAcceptedRoot {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly activeMessageId: string | null;
	readonly turnId: string | null;
	readonly correlation: AcceptedCorrelation | null;
	readonly transcript: TranscriptRoot;
}

export interface SessionBootstrap {
	readonly leafId: string | null;
}

/** Recovery kinds take a sequence; responses and every other record keep FIFO order with none. */
const SEQUENCED = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"entry_appended",
	"session_abort",
]);

function field(record: object, key: string): unknown {
	return key in record ? Reflect.get(record, key) : undefined;
}

function turnScoped(type: string, record: object): boolean {
	if (type === "turn_end" || type.startsWith("tool_execution_")) return true;
	if (!type.startsWith("message_")) return false;
	const role = field(Object(field(record, "message")), "role");
	return role === "assistant" || role === "toolResult";
}

/**
 * The ordered acceptance lane of one routing session. Every record reaches it synchronously, before
 * `SessionEventWriter.enqueue`, in the order the session produced it; a worker's records arrive here before
 * the worker's credit returns. Each bootstrap starts a new `sessionEpoch` whose sequences are never compared
 * with another epoch's.
 */
export class SessionAcceptanceLane {
	private epoch = "";
	private sequence = 0;
	private historyVersion = 0;
	private leafId: string | null = null;
	private entries: string[] = [];
	private activeMessageId: string | null = null;
	private turnId: string | null = null;
	private correlation: AcceptedCorrelation | null = null;
	private readonly live = new Set<FrozenAcceptedRoot>();
	private retiredAs: "close" | "worker_failed" | undefined;

	get retired(): boolean {
		return this.retiredAs !== undefined;
	}

	get liveRoots(): number {
		return this.live.size;
	}

	bootstrap(input: SessionBootstrap): void {
		if (this.retired) return;
		this.epoch = randomUUID();
		this.sequence = 0;
		this.historyVersion = 0;
		this.leafId = input.leafId;
		this.entries = [];
		this.activeMessageId = null;
		this.turnId = null;
		this.correlation = null;
	}

	accept(record: object, carrier: RecoveryCarrier | undefined): AcceptedRef | undefined {
		const type = field(record, "type");
		if (this.retired || this.epoch === "" || typeof type !== "string" || !SEQUENCED.has(type)) return undefined;
		this.acceptCorrelation(record);
		this.sequence += 1;
		if (type === "turn_start" || (this.turnId === null && turnScoped(type, record))) this.turnId = randomUUID();
		const turnId = this.turnId;
		if (type === "turn_end" || type === "agent_end") this.turnId = null;
		const messageId = type.startsWith("message_") ? (carrier?.messageId ?? null) : null;
		if (type === "message_start") this.activeMessageId = messageId;
		if (type === "message_end" && this.activeMessageId === messageId) this.activeMessageId = null;
		if (type === "entry_appended") this.acceptAppend(field(record, "entry"));
		return {
			sessionEpoch: this.epoch,
			sequence: this.sequence,
			historyVersion: this.historyVersion,
			messageId,
			turnId,
		};
	}

	freeze(): FrozenAcceptedRoot {
		const root: FrozenAcceptedRoot = Object.freeze({
			sessionEpoch: this.epoch,
			sequence: this.sequence,
			activeMessageId: this.activeMessageId,
			turnId: this.turnId,
			correlation: this.correlation,
			transcript: Object.freeze({
				historyVersion: this.historyVersion,
				leafId: this.leafId,
				entries: this.entries,
				count: this.entries.length,
			}),
		});
		this.live.add(root);
		return root;
	}

	release(root: FrozenAcceptedRoot): void {
		this.live.delete(root);
	}

	/** No record is accepted after retirement, and every root this lane published is released. */
	retire(reason: "close" | "worker_failed"): void {
		this.retiredAs ??= reason;
		this.live.clear();
	}

	/** A change of the outer client correlation is its own transition, sequenced just before its record (C1.1). */
	private acceptCorrelation(record: object): void {
		if (!("clientMessageId" in record) && !("clientTurnId" in record)) return;
		const next = {
			clientMessageId: field(record, "clientMessageId"),
			clientTurnId: field(record, "clientTurnId"),
			clientMessages: field(record, "clientMessages"),
		};
		const current = this.correlation;
		if (
			current !== null &&
			current.clientMessageId === next.clientMessageId &&
			current.clientTurnId === next.clientTurnId &&
			JSON.stringify(current.clientMessages) === JSON.stringify(next.clientMessages)
		)
			return;
		this.sequence += 1;
		this.correlation = Object.freeze({ sequence: this.sequence, ...next });
	}

	/** The root owns a serialized value: the manager may later mutate the entry object (mirror trimming). */
	private acceptAppend(entry: unknown): void {
		if (typeof entry !== "object" || entry === null) return;
		this.historyVersion += 1;
		const id = field(entry, "id");
		this.leafId = typeof id === "string" ? id : this.leafId;
		this.entries.push(JSON.stringify(entry));
	}
}
