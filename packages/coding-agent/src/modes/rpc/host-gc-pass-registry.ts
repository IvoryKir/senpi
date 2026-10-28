/**
 * The opportunistic gc passes this process has in flight, keyed by agent directory. `host-gc-pass.ts`
 * starts them; this leaf only records them, so a caller that must not remove an agent directory under
 * a running pass (a test teardown, senpi#4382) can join them without loading the gc module graph.
 */
import { isAbsolute, join, relative, resolve } from "node:path";

const passesRunning = new Map<string, Promise<void>>();

export function opportunisticHostGcRunning(agentDir: string): boolean {
	return passesRunning.has(agentDir);
}

export function trackOpportunisticHostGc(agentDir: string, pass: Promise<void>): void {
	passesRunning.set(agentDir, pass);
	void pass.finally(() => {
		if (passesRunning.get(agentDir) === pass) passesRunning.delete(agentDir);
	});
}

/** Resolves once the pass this process scheduled for `agentDir` (if any) has finished; it never rejects. */
export function settledOpportunisticHostGc(agentDir: string): Promise<void> {
	return passesRunning.get(agentDir) ?? Promise.resolve();
}

/** The agent directories with a pass in flight whose `rpc-host-daemon` (where a pass writes) lies inside `path`. */
export function opportunisticHostGcWithin(path: string): readonly string[] {
	return [...passesRunning.keys()].filter((agentDir) => contains(path, join(agentDir, "rpc-host-daemon")));
}

export async function settledOpportunisticHostGcWithin(path: string): Promise<void> {
	await Promise.all(opportunisticHostGcWithin(path).map(settledOpportunisticHostGc));
}

function contains(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
