import { Worker } from "node:worker_threads";
import type { ResolverRequest, ResolverValue, ResolverWorkerMessage } from "./path-identity-protocol.ts";

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

export class ResolverTimeoutError extends Error {
	readonly code = "ETIMEDOUT";
	constructor(detail: string) {
		super(`ETIMEDOUT: ${detail}`);
		this.name = "ResolverTimeoutError";
	}
}

export class ResolverFailure extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "ResolverFailure";
		this.code = code;
	}
}

export function workerTransport(): ResolverTransport {
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
