import { Worker } from "node:worker_threads";
import { createMountRewrite, type MountSnapshot, volumeKeyFor } from "./alias-detector.ts";
import type { CanonicalPath, CanonicalRule } from "./path-identity.ts";
import type { ResolverRequest, ResolverValue, ResolverWorkerMessage } from "./path-identity-protocol.ts";

export const DEFAULT_CHECK_DEADLINE_MS = 2000;
export const RULE_FILL_DEADLINE_MS = 250;
export const LEAK_GRACE_MS = 1000;
export const MAX_LEAKED_WORKERS = 3;
export const BREAKER_OPEN_AFTER = 2;
export const BREAKER_BACKOFF_MS = 5000;
export const BREAKER_BACKOFF_MAX_MS = 60_000;

/** One derivation for the resolver deadline: three quarters of the slot deadline, capped at 1.5 s. */
export function resolverDeadlineMs(checkDeadlineMs: number = DEFAULT_CHECK_DEADLINE_MS): number {
	return Math.min(1500, Math.floor(checkDeadlineMs * 0.75));
}

export type BreakerState = "closed" | "open" | "half-open";

export interface ResolverStateEvent {
	readonly volumeKey: string;
	readonly state: BreakerState | "leak-cap" | "leak-recovered";
	readonly leaked: number;
}

/** The worker transport, injectable so a test can stall it without a real wedge. */
export interface ResolverTransport {
	post(request: ResolverRequest): void;
	onMessage(handler: (message: ResolverWorkerMessage) => void): void;
	onExit(handler: () => void): void;
	terminate(): Promise<unknown>;
}

export interface ResolverRequestOptions {
	/** An eager rule fill: its own short deadline, and a miss never terminates, rejects others or trips the breaker. */
	readonly soft?: boolean;
	/** A soft request's answer that arrives after its deadline is still delivered here (the worker computed it anyway). */
	readonly onLate?: (value: ResolverValue) => void;
}

export interface PathIdentityResolver {
	canonicalize(executed: string, cwd?: string, options?: ResolverRequestOptions): Promise<CanonicalPath>;
	canonicalizeRule(
		pattern: string,
		cwd?: string,
		options?: ResolverRequestOptions,
	): Promise<CanonicalRule | undefined>;
	/** True when an alias may be in play for the path; every error, timeout or budget miss answers true. */
	detect(path: string, options?: ResolverRequestOptions): Promise<boolean>;
	walk(path: string, options?: ResolverRequestOptions): Promise<string>;
	volumeKey(path: string): string;
	breakerState(key: string): BreakerState;
	onState(handler: (event: ResolverStateEvent) => void): () => void;
	/** Spawn the worker now (it is otherwise started by the first request). */
	start(): void;
	readonly leaked: number;
	readonly snapshot: MountSnapshot | undefined;
	close(): Promise<void>;
}

export interface ResolverHostOptions {
	readonly checkDeadlineMs?: number;
	readonly spawn?: () => ResolverTransport;
	readonly onState?: (event: ResolverStateEvent) => void;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
}

export class ResolverTimeoutError extends Error {
	readonly code = "ETIMEDOUT";
	constructor(detail: string) {
		super(`ETIMEDOUT: ${detail}`);
		this.name = "ResolverTimeoutError";
	}
}

class ResolverFailure extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "ResolverFailure";
		this.code = code;
	}
}

type RequestBody = ResolverRequest extends infer R ? (R extends ResolverRequest ? Omit<R, "id"> : never) : never;

interface Pending {
	readonly key: string;
	readonly soft: boolean;
	readonly resolve: (value: ResolverValue) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface Breaker {
	state: BreakerState;
	consecutive: number;
	backoffMs: number;
	probe?: ReturnType<typeof setTimeout>;
}

function workerTransport(): ResolverTransport {
	const entry = new URL(
		import.meta.url.endsWith(".ts") ? "./path-identity-worker.ts" : "./path-identity-worker.js",
		import.meta.url,
	);
	const worker = new Worker(entry);
	worker.unref();
	return {
		post: (request) => worker.postMessage(request),
		onMessage: (handler) => {
			worker.on("message", handler);
		},
		onExit: (handler) => {
			worker.on("exit", handler);
			worker.on("error", handler);
		},
		terminate: () => worker.terminate(),
	};
}

export function createPathIdentityResolver(options: ResolverHostOptions = {}): PathIdentityResolver {
	const deadlineMs = resolverDeadlineMs(options.checkDeadlineMs);
	const spawn = options.spawn ?? workerTransport;
	const log = options.log ?? ((line: string) => console.warn(`permission resolver: ${line}`));
	const pending = new Map<number, Pending>();
	const breakers = new Map<string, Breaker>();
	let worker: { transport: ResolverTransport; live: boolean } | undefined;
	let snapshot: MountSnapshot | undefined;
	let rewrite = createMountRewrite([]);
	let leaked = 0;
	let nextId = 1;
	let closed = false;

	const listeners = new Set<(event: ResolverStateEvent) => void>();
	if (options.onState) listeners.add(options.onState);
	const emit = (volumeKey: string, state: ResolverStateEvent["state"]) => {
		log(`${volumeKey}: ${state} (leaked workers: ${leaked})`);
		const event = { volumeKey, state, leaked };
		for (const listener of listeners) listener(event);
	};

	const breakerFor = (key: string): Breaker => {
		let breaker = breakers.get(key);
		if (!breaker) {
			breaker = { state: "closed", consecutive: 0, backoffMs: BREAKER_BACKOFF_MS };
			breakers.set(key, breaker);
		}
		return breaker;
	};

	const scheduleProbe = (key: string, breaker: Breaker) => {
		breaker.probe = setTimeout(() => {
			breaker.probe = undefined;
			if (breaker.state !== "open") return;
			if (leaked >= MAX_LEAKED_WORKERS) {
				scheduleProbe(key, breaker);
				return;
			}
			breaker.state = "half-open";
			emit(key, "half-open");
		}, breaker.backoffMs);
		breaker.probe.unref?.();
	};

	const recordTimeout = (key: string) => {
		const breaker = breakerFor(key);
		breaker.consecutive += 1;
		if (breaker.state === "half-open" || breaker.consecutive >= BREAKER_OPEN_AFTER) {
			if (breaker.state === "half-open") breaker.backoffMs = Math.min(breaker.backoffMs * 2, BREAKER_BACKOFF_MAX_MS);
			breaker.state = "open";
			emit(key, "open");
			scheduleProbe(key, breaker);
		}
	};

	const recordSuccess = (key: string) => {
		const breaker = breakerFor(key);
		const was = breaker.state;
		breaker.consecutive = 0;
		breaker.state = "closed";
		breaker.backoffMs = BREAKER_BACKOFF_MS;
		if (was !== "closed") {
			emit(key, "closed");
			requestRefresh();
		}
	};

	const settle = (id: number): Pending | undefined => {
		const entry = pending.get(id);
		if (!entry) return undefined;
		pending.delete(id);
		clearTimeout(entry.timer);
		return entry;
	};

	const attach = (transport: ResolverTransport) => {
		const handle = { transport, live: true };
		worker = handle;
		transport.onMessage((message) => {
			if (worker !== handle) return;
			if ("type" in message) {
				snapshot = message.snapshot;
				rewrite = createMountRewrite(message.firmlinks);
				return;
			}
			const entry = settle(message.id);
			if (!entry) return;
			if (message.ok) {
				if (!entry.soft) recordSuccess(entry.key);
				entry.resolve(message.value);
			} else {
				if (!entry.soft) recordSuccess(entry.key);
				entry.reject(new ResolverFailure(message.code));
			}
		});
		transport.onExit(() => {
			if (worker !== handle) return;
			handle.live = false;
			worker = undefined;
			rejectAll("resolver worker exited");
		});
		return handle;
	};

	const rejectAll = (detail: string) => {
		for (const [id, entry] of [...pending]) {
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new ResolverTimeoutError(detail));
		}
	};

	const retire = (detail: string) => {
		const current = worker;
		worker = undefined;
		rejectAll(detail);
		if (!current) return;
		current.live = false;
		let counted = false;
		const grace = setTimeout(() => {
			counted = true;
			leaked += 1;
			if (leaked >= MAX_LEAKED_WORKERS) emit("process", "leak-cap");
		}, LEAK_GRACE_MS);
		grace.unref?.();
		void current.transport.terminate().then(
			() => {
				clearTimeout(grace);
				if (counted) {
					leaked -= 1;
					emit("process", "leak-recovered");
				}
			},
			() => {},
		);
	};

	const ensureWorker = (): ResolverTransport | undefined => {
		if (worker?.live) return worker.transport;
		if (leaked >= MAX_LEAKED_WORKERS) return undefined;
		return attach(spawn()).transport;
	};

	const requestRefresh = () => {
		const transport = worker?.live ? worker.transport : undefined;
		transport?.post({ id: nextId++, kind: "refresh" });
	};

	const send = (
		request: RequestBody,
		path: string,
		soft: boolean,
		onLate?: (value: ResolverValue) => void,
	): Promise<ResolverValue> => {
		if (closed) return Promise.reject(new ResolverTimeoutError("resolver closed"));
		const transport = ensureWorker();
		const key = volumeKeyFor(snapshot, rewrite, path);
		const breaker = breakerFor(key);
		if (breaker.state === "open") return Promise.reject(new ResolverTimeoutError(`breaker open for ${key}`));
		if (!transport) return Promise.reject(new ResolverTimeoutError("leaked worker cap reached"));
		const id = nextId++;
		const budget = soft ? RULE_FILL_DEADLINE_MS : deadlineMs;
		return new Promise<ResolverValue>((resolve, reject) => {
			const timer = setTimeout(() => {
				const entry = settle(id);
				if (!entry) return;
				entry.reject(new ResolverTimeoutError(`${request.kind} ${path} after ${budget} ms`));
				if (entry.soft) {
					// The worker still computes it; a late answer is handed to onLate and never counts against anything.
					pending.set(id, { key, soft: true, resolve: onLate ?? (() => {}), reject: () => {}, timer: undefined });
					return;
				}
				recordTimeout(key);
				retire(`resolver stalled on ${key}`);
			}, budget);
			timer.unref?.();
			pending.set(id, { key, soft, resolve, reject, timer });
			transport.post({ ...request, id } as ResolverRequest);
		});
	};

	return {
		canonicalize: (executed, cwd, requestOptions) =>
			send(
				{ kind: "canonicalize", path: executed, cwd },
				executed,
				requestOptions?.soft ?? false,
				requestOptions?.onLate,
			) as Promise<CanonicalPath>,
		canonicalizeRule: (pattern, cwd, requestOptions) =>
			send(
				{ kind: "canonicalizeRule", pattern, cwd },
				pattern,
				requestOptions?.soft ?? false,
				requestOptions?.onLate,
			) as Promise<CanonicalRule | undefined>,
		detect: (path, requestOptions) =>
			send({ kind: "detect", path }, path, requestOptions?.soft ?? false, requestOptions?.onLate).then(
				(value) => value !== false,
				() => true,
			),
		walk: (path, requestOptions) =>
			send({ kind: "walk", path }, path, requestOptions?.soft ?? false, requestOptions?.onLate) as Promise<string>,
		start: () => {
			if (!closed) ensureWorker();
		},
		volumeKey: (path) => volumeKeyFor(snapshot, rewrite, path),
		breakerState: (key) => breakers.get(key)?.state ?? "closed",
		onState: (handler) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		get leaked() {
			return leaked;
		},
		get snapshot() {
			return snapshot;
		},
		close: async () => {
			closed = true;
			for (const breaker of breakers.values()) clearTimeout(breaker.probe);
			const current = worker;
			worker = undefined;
			rejectAll("resolver closed");
			if (current) await current.transport.terminate().catch(() => {});
		},
	};
}

let shared: PathIdentityResolver | undefined;

/** One worker per process serves every session (design 6.7). */
export function sharedPathIdentityResolver(): PathIdentityResolver {
	shared ??= createPathIdentityResolver();
	return shared;
}
