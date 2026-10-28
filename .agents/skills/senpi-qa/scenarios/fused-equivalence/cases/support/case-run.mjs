// One EQ case run: a sandbox, the fake model server, and the real CLI (`--mode rpc`, persisted session) on the
// driver's child runtime. Everything a case does goes through this object, so every case is observed the same way.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childRuntime, makeSandbox, repoRoot } from "../../../../scripts/lib/common.mjs";
import { startFakeModelServer } from "../../../../scripts/lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../../../../scripts/lib/mock-loop-support.mjs";
import { RpcClient } from "../../../../scripts/lib/rpc-client.mjs";

export const FIXTURES = join(dirname(new URL(import.meta.url).pathname), "..", "..", "fixtures");
const TURN_TIMEOUT_MS = 120_000;
/** A loaded host can hold a Bun child's first file opens for minutes (seen: 2 min in uninterruptible I/O). */
const OPEN_TIMEOUT_MS = 300_000;

/** Terminal-identity variables the CLI renders into its prompt; the sandbox pins them so every host sees the same. */
const TERMINAL_ENV = ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "TERM_SESSION_ID", "ITERM_SESSION_ID"];

/**
 * @param {{ label: string, turns: object[], api?: string, models?: object[], files?: Record<string,string>,
 *   settings?: object, extensions?: string[], extraArgs?: string[], env?: Record<string,string> }} spec
 */
export async function startCaseRun(spec) {
	const api = spec.api ?? "openai-completions";
	const preset = API_PRESETS[api];
	const box = makeSandbox(`eq-${spec.label}`);
	const server = await startFakeModelServer({ turns: spec.turns });
	writeMockModelsJson(box.agentDir, server, api, {}, { models: spec.models ?? [] });
	if (spec.settings) writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify(spec.settings, null, 2));
	for (const [rel, content] of Object.entries(spec.files ?? {})) {
		mkdirSync(dirname(join(box.cwd, rel)), { recursive: true });
		writeFileSync(join(box.cwd, rel), content);
	}
	const env = hermeticEnv(box.env);
	for (const name of TERMINAL_ENV) delete env[name];
	Object.assign(env, { TERM: "xterm-256color", EQ_BARRIER_ORIGIN: server.origin }, spec.env ?? {});
	const baseArgs = ["--provider", preset.provider, "--model", preset.modelId, "--no-skills"];
	const extensionArgs = (spec.extensions ?? []).flatMap((path) => ["--extension", path]);
	const run = {
		api,
		box,
		server,
		env,
		clients: [],
		sessionFile: undefined,
		sessionIds: [],
		states: [],
		effects: [],
		/** Run-scoped prefixes a case allocates itself (a fixture server's origin), replaced like the sandbox root. */
		extraRoots: [],
		/** Cleanups a case registers (fixture servers it started); run after every child has exited. */
		cleanups: [],
		args: [...baseArgs, ...extensionArgs, ...(spec.extraArgs ?? [])],
		/** Start (or restart) the RPC child; `resume` reopens the persisted session file. */
		async open({ resume = false } = {}) {
			const args = resume ? [...run.args, "--session", run.sessionFile] : run.args;
			const client = new RpcClient({ env, cwd: box.cwd, extraArgs: args });
			run.clients.push(client);
			// A cold start (tsx transpiling the CLI on the Node child, or a loaded disk) takes far longer than a warm one.
			const state = await client.send({ type: "get_state" }, { timeoutMs: OPEN_TIMEOUT_MS });
			if (!state.success) throw new Error(`get_state failed: ${JSON.stringify(state).slice(0, 400)}`);
			run.sessionFile ??= state.data.sessionFile;
			run.sessionIds.push(state.data.sessionId);
			return client;
		},
		get client() {
			return run.clients.at(-1);
		},
		/** Send a command on the current client and fail the case on an unsuccessful response. */
		async send(command) {
			const response = await run.client.send(command, { timeoutMs: TURN_TIMEOUT_MS });
			if (!response.success) throw new Error(`${command.type} failed: ${JSON.stringify(response).slice(0, 400)}`);
			return response;
		},
		/** Send a prompt and wait for this run's next agent_idle. */
		async prompt(message, extra = {}) {
			const idle = run.nextEvent((event) => event.type === "agent_idle");
			await run.send({ type: "prompt", message, ...extra });
			return idle;
		},
		/** Resolve on the first matching event that arrives after this call. */
		nextEvent(pred, { timeoutMs = TURN_TIMEOUT_MS } = {}) {
			const client = run.client;
			const seen = client.events.length;
			const waiting = client.waitForEvent((event) => client.events.indexOf(event) >= seen && pred(event), {
				timeoutMs,
			});
			// A wait the case abandons after another step failed must not crash the driver later; awaiting it still throws.
			waiting.catch(() => {});
			return waiting;
		},
		/** End the current child's stdin and wait for it to exit; its event list is then complete. */
		async close() {
			const client = run.client;
			client.close();
			await exited(client.child);
		},
		/** SIGKILL the current child (crash), then wait for it to exit. */
		async kill() {
			const client = run.client;
			client.child.kill("SIGKILL");
			await exited(client.child);
		},
		/** O8 headless: reopen the persisted session in a fresh child, read get_state, close it. */
		async reopenState() {
			const client = await run.open({ resume: true });
			const state = await run.send({ type: "get_state" });
			run.states.push(state.data);
			await run.close();
			return client;
		},
		async stop() {
			for (const client of run.clients) client.close();
			await Promise.all(run.clients.map((client) => exited(client.child)));
			for (const cleanup of run.cleanups.reverse()) await cleanup();
			await server.stop();
		},
		childRuntime: childRuntime().label,
		repo: repoRoot(),
	};
	return run;
}

function exited(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}
