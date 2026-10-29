import { isMainThread, type Transferable, workerData } from "node:worker_threads";

/** What a provider hands one session Worker: its value, what to transfer with it, and its cleanup. */
export interface SessionWorkerDataGrant {
	readonly value: unknown;
	readonly transfer?: readonly Transferable[];
	dispose?(): void;
}

export type SessionWorkerDataProvider = () => SessionWorkerDataGrant;

export interface IssuedSessionWorkerData {
	readonly extensionData: Readonly<Record<string, unknown>>;
	readonly transfer: readonly Transferable[];
	dispose(): void;
}

const disposeAll = (grants: readonly SessionWorkerDataGrant[]): void => {
	for (const grant of grants) grant.dispose?.();
};

/**
 * Per-session-Worker data an extension host provides before the first session Worker spawns (senpi#4728).
 * Every session Worker gets its own value from each provider, never a shared or broadcast one.
 */
export class SessionWorkerDataRegistry {
	private readonly providers = new Map<string, SessionWorkerDataProvider>();
	private sealed = false;

	provide(name: string, create: SessionWorkerDataProvider): void {
		if (!isMainThread) throw new Error("provideSessionWorkerData runs on the main thread only");
		if (this.sealed) throw new Error(`session worker data "${name}" was provided after the first session worker`);
		if (this.providers.has(name)) throw new Error(`session worker data "${name}" is already provided`);
		this.providers.set(name, create);
	}

	spawn<T>(start: (issued: IssuedSessionWorkerData) => T): {
		readonly result: T;
		readonly issued: IssuedSessionWorkerData;
	} {
		this.sealed = true;
		const grants: SessionWorkerDataGrant[] = [];
		const extensionData: Record<string, unknown> = {};
		try {
			for (const [name, create] of this.providers) {
				const grant = create();
				grants.push(grant);
				extensionData[name] = grant.value;
			}
		} catch (cause) {
			disposeAll(grants);
			throw cause;
		}
		let disposed = false;
		const issued: IssuedSessionWorkerData = {
			extensionData,
			transfer: grants.flatMap((grant) => grant.transfer ?? []),
			dispose: () => {
				if (disposed) return;
				disposed = true;
				disposeAll(grants);
			},
		};
		try {
			return { result: start(issued), issued };
		} catch (cause) {
			issued.dispose();
			throw cause;
		}
	}
}

export const sessionWorkerDataRegistry = new SessionWorkerDataRegistry();

export function provideSessionWorkerData(name: string, create: SessionWorkerDataProvider): void {
	sessionWorkerDataRegistry.provide(name, create);
}

export function readSessionWorkerData(data: unknown, name: string): unknown {
	const extensionData: unknown =
		data !== null && typeof data === "object" ? Reflect.get(data, "extensionData") : undefined;
	if (extensionData === null || typeof extensionData !== "object" || !Object.hasOwn(extensionData, name))
		return undefined;
	return Reflect.get(extensionData, name);
}

/** The value a provider issued to this session Worker; undefined when not provided or outside a session Worker. */
export function sessionWorkerData(name: string): unknown {
	return isMainThread ? undefined : readSessionWorkerData(workerData, name);
}
