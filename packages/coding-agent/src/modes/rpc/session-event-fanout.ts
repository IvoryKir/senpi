import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { LegacyReplayStore } from "./legacy-replay-store.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";
import { EVENT_RESYNC_CAPABILITY } from "./socket-peer-recovery.ts";

export type RawWriter = (chunk: string) => void;
export type BackpressureWaiter = () => Promise<void>;

export interface SessionEventWriterConnection {
	readonly writeRaw: RawWriter;
	readonly waitForBackpressure: BackpressureWaiter;
	/**
	 * Tears the transport down. Called when this connection's event queue fails
	 * (overflow, write error): the actor has already stopped delivering records
	 * AND command responses, so a socket left open would strand the client on a
	 * connection that can never answer again. Closing it lets the client resync.
	 */
	readonly close?: () => void;
}

const BROADCAST_LIFECYCLE_RECORDS = new Set([
	"agent_start",
	"agent_settled",
	"agent_idle",
	"session_opened",
	"session_closed",
	"session_lifecycle",
]);

type RegisteredConnection = {
	readonly connection: SessionEventWriterConnection;
	readonly actor: SocketEventSinkActor;
};

/** A lane root pinned for one frozen view, released once on that view's end (R3.C1.5). */
type PinnedRoot = { readonly lane: SessionAcceptanceLane; readonly root: FrozenAcceptedRoot; readonly epoch: string };

export class SessionEventFanout {
	onConnectionClosed?: (id: string) => void;
	/** Each routing session's acceptance lane; retired when the session is sealed or forgotten. */
	readonly acceptance = new Map<string, SessionAcceptanceLane>();
	/** The retained legacy replay source every late peer's baseline is frozen from (S07b replaces it). */
	readonly replay = new LegacyReplayStore();
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	/** Per connection, each attached session with the ordinal of the attach that holds it. */
	private readonly connectionSessions = new Map<string, Map<string, number>>();
	private attachOrdinal = 0;
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
	): void {
		const actor = new SocketEventSinkActor(
			connection,
			(cause) => {
				if (this.connections.get(id)?.actor === actor) {
					this.connections.delete(id);
					this.connectionCapabilities.delete(id);
					this.connectionSessions.delete(id);
					this.registeredCapabilityConnections.delete(id);
					this.onConnectionClosed?.(id);
				}
				process.stderr.write(
					`senpi rpc connection ${id} event queue failed; closing: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
				connection.close?.();
			},
			options.maxQueueBytes,
			options.stallMs,
		);
		this.connections.set(id, { connection, actor });
		this.connectionCapabilities.set(id, new Set());
		this.connectionSessions.set(id, new Map());
	}

	unregisterConnection(id: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		registered.actor.close();
		this.connections.delete(id);
		this.connectionCapabilities.delete(id);
		this.connectionSessions.delete(id);
		this.registeredCapabilityConnections.delete(id);
	}

	/**
	 * A first attach freezes the cut C synchronously (the lane root and today's replay view) and installs that
	 * peer's baseline barrier before the session is live for it; a repeated hold adds nothing. The attempt dies
	 * with a detach, the peer, or a replacement (new lane epoch), and releases its root in every case.
	 */
	attachConnectionToSession(id: string, sessionId: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		const sessions = this.connectionSessions.get(id) ?? new Map<string, number>();
		if (sessions.has(sessionId)) return;
		const ordinal = ++this.attachOrdinal;
		sessions.set(sessionId, ordinal);
		this.connectionSessions.set(id, sessions);
		const pinned = this.pin([sessionId]);
		const cursor = this.replay.freezeAttach(sessionId, {
			placeholders: this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY),
			now: Date.now(),
			onRelease: () => this.unpin(pinned),
		});
		registered.actor.installBaseline(
			cursor,
			() =>
				this.connections.get(id)?.actor === registered.actor &&
				this.connectionSessions.get(id)?.get(sessionId) === ordinal &&
				pinned.every(({ lane, epoch }) => lane.recoveryEpoch === epoch),
		);
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		this.connectionSessions.get(id)?.delete(sessionId);
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		this.connectionCapabilities.set(id, new Set(capabilities));
		this.registeredCapabilityConnections.add(id);
		if (capabilities.includes(EVENT_RESYNC_CAPABILITY)) {
			// Frozen at the shed, before the actor awaits its drain (R3.C1.5); released when the recovery ends.
			registered.actor.enableRecovery((reason) => {
				const attached = [...(this.connectionSessions.get(id)?.keys() ?? [])];
				const pinned = this.pin(attached);
				return this.replay.freezeResync({
					sessions: attached,
					reason,
					placeholders: this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY),
					closedNow: (sessionId) => !this.connectionSessions.get(id)?.has(sessionId),
					onRelease: () => this.unpin(pinned),
				});
			});
		} else registered.actor.disableRecovery();
	}

	clearConnectionCapabilities(id: string): void {
		if (this.connections.has(id)) {
			this.connectionCapabilities.set(id, new Set());
			this.registeredCapabilityConnections.delete(id);
		}
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.registeredCapabilityConnections.has(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		if (!this.registeredCapabilityConnections.has(id)) return undefined;
		return [...(this.connectionCapabilities.get(id) ?? [])];
	}

	/** Whether a connection advertised a capability. The only capability lookup in this file. */
	connectionHas(id: string | undefined, capability: string): boolean {
		return id === undefined ? false : (this.connectionCapabilities.get(id)?.has(capability) ?? false);
	}

	targets(
		sessionId: string,
		targetId: string | undefined,
		isTargeted: boolean,
		recordType: unknown,
	): readonly (string | undefined)[] {
		if (isTargeted) return [targetId];
		if (typeof recordType === "string" && BROADCAST_LIFECYCLE_RECORDS.has(recordType))
			return this.connections.size > 0 ? [...this.connections.keys()] : [undefined];
		return this.connections.size > 0
			? [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId))
			: [undefined];
	}

	get(id: string): RegisteredConnection | undefined {
		return this.connections.get(id);
	}

	values(): IterableIterator<RegisteredConnection> {
		return this.connections.values();
	}

	/** True when no socket connection is registered, i.e. records must fall back to the stdio lane. */
	isEmpty(): boolean {
		return this.connections.size === 0;
	}

	broadcast(line: string): void {
		for (const { actor } of this.connections.values()) actor.enqueue(line);
	}

	connectionIds(): readonly string[] {
		return [...this.connections.keys()];
	}

	attachedConnections(sessionId: string): readonly string[] {
		return [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId));
	}

	/** Pending `question` frames a session has asked and nobody answered yet. */
	pendingQuestionCount(sessionId: string): number {
		return this.replay.pendingQuestionCount(sessionId);
	}

	/** Deliver one line to the connections attached to a session, never to the rest of the fanout. */
	deliverToSession(sessionId: string, line: string): void {
		for (const [id, { actor }] of this.connections)
			if (this.connectionSessions.get(id)?.has(sessionId)) actor.enqueue(line);
	}

	rememberSnapshot(sessionId: string, value: Record<string, unknown>, line: string, placeholderLine?: string): void {
		this.replay.remember(sessionId, value, line, placeholderLine);
	}

	forgetSession(sessionId: string): void {
		this.acceptance.get(sessionId)?.retire("close");
		this.acceptance.delete(sessionId);
		this.replay.forget(sessionId);
	}

	private pin(sessionIds: readonly string[]): readonly PinnedRoot[] {
		return sessionIds.flatMap((sessionId) => {
			const lane = this.acceptance.get(sessionId);
			return lane && !lane.retired ? [{ lane, root: lane.freeze(), epoch: lane.recoveryEpoch }] : [];
		});
	}

	private unpin(pinned: readonly PinnedRoot[]): void {
		for (const { lane, root } of pinned) lane.release(root);
	}
}
