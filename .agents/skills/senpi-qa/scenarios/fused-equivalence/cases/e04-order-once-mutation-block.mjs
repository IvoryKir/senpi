// E04 (plan §6.4, G1 + the P0-02a fixture design): order-once + PostToolUse mutation + block. O1-O8.
//
// One batch of two calls to the inactive `qa` tool: `{legacy:"42"}` runs the whole order exactly once (activate, shim,
// handlers, the trusted shell PreToolUse hook, body, then the PostToolUse hook that replaces the result), and
// `{legacy:"7"}` is blocked by hook2, so its body never runs. trace.log (O5 tree) holds the order; the replaced result
// and the block reason reach the next request (O1) and the transcript (O7).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveBun } from "../../../scripts/lib/common.mjs";
import { FIXTURES } from "./support/case-run.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

const E04 = join(FIXTURES, "e04");

export default {
	id: "E04",
	title: "order-once + PostToolUse mutation + block (G1)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [join(E04, "qa-extension.mjs"), join(E04, "block-extension.mjs")],
		turns: [
			{
				toolCalls: [
					{ id: "g1-run", name: "qa", args: { legacy: "42" } },
					{ id: "g1-block", name: "qa", args: { legacy: "7" } },
				],
			},
			{ text: "E04-DONE" },
		],
	},
	async drive(run) {
		const node = process.execPath;
		const hook = join(E04, "shell-hook.mjs");
		const trace = join(run.box.cwd, "trace.log");
		const command = (kind) => `${JSON.stringify(node)} ${JSON.stringify(hook)} ${kind} ${JSON.stringify(trace)}`;
		const setup = spawnSync(
			resolveBun().command,
			[join(E04, "write-hooks.ts"), run.box.cwd, command("pre"), command("post")],
			{
				encoding: "utf8",
			},
		);
		if (setup.status !== 0) throw new Error(`write-hooks.ts failed: ${setup.stderr}`);
		await run.open();
		await run.prompt("run qa twice");
		await run.close();
		await run.reopenState();
	},
};
