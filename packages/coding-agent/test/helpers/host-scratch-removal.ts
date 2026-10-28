import { rm } from "node:fs/promises";
import { settledOpportunisticHostGc } from "../../src/modes/rpc/host-gc-pass.ts";
import type { GenerationScratch } from "./rpc-generation-support.ts";

/**
 * Removes a host test's scratch tree once nothing in this process can still write into it (#4382).
 * `ensureHost` returns before the gc pass it schedules has run, and that pass writes its marker into
 * `<agentDir>/rpc-host-daemon`; a removal racing that write fails with ENOTEMPTY on the directory.
 */
export async function removeHostScratch(qa: GenerationScratch): Promise<void> {
	await settledOpportunisticHostGc(qa.agentDir);
	await rm(qa.root, { recursive: true, force: true });
}
