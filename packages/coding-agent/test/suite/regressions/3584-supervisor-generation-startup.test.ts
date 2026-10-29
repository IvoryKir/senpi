import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createGenerationDirectory,
	createHostDaemonPaths,
	generationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "../../../src/modes/rpc/host-identity-env.ts";
import * as internalHop from "../../../src/modes/rpc/host-lifecycle-internal-key.ts";
import { runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";

vi.mock("../../../src/modes/rpc/host-lifecycle-internal-key.ts", { spy: true });

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])("makes generation state writable before child startup (already ensured=%s)", async (ensured) => {
	// Given a fresh direct launch, or the generation an ensure has already provisioned.
	const root = await mkdtemp(join(tmpdir(), "rpc3584-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const socket = join(root, "rpc.sock");
	const paths = createHostDaemonPaths({ agentDir, socket });
	const instanceId = "starting-generation";
	const generation = generationPaths(paths, instanceId);
	const settings = { instanceId, generation: 7 };
	vi.stubEnv(HOST_INSTANCE_ID_ENV, instanceId);
	if (ensured) {
		await createGenerationDirectory(generation);
		await writeFile(generation.settingsFile, JSON.stringify(settings));
	}
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const stopped = new Error("startup held before allocating the internal hop or spawning a child");

	await vi.mocked(internalHop.prepareInternalHop).withImplementation(
		async () => {
			entered.resolve();
			await release.promise;
			throw stopped;
		},
		async () => {
			// When startup reaches the gate, no host child or other directory writer exists.
			const starting = runHostSupervisor({ agentDir, socket, hostArgs: [] });
			starting.catch(() => undefined);
			try {
				await entered.promise;
				// Then the exact atomic file operation used by recordChildPid can already succeed.
				// On main, a direct launch fails here with ENOENT without any removal or contention.
				const child = { pid: process.pid, processStartTime: null };
				await writeJsonAtomic(generation.childPidFile, child);
				expect(JSON.parse(await readFile(generation.childPidFile, "utf8"))).toEqual(child);
				if (ensured) {
					expect(JSON.parse(await readFile(generation.settingsFile, "utf8"))).toEqual(settings);
				}
			} finally {
				release.resolve();
				await expect(starting).rejects.toBe(stopped);
			}
		},
	);
});
