import { afterEach, expect, it, vi } from "vitest";
import {
	cellEnforcementState,
	type CellOperation,
	decideCellOperation,
	onCellEnforcementChange,
} from "../../src/core/extensions/builtin/permission-system/cell-decision.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness } from "../suite/harness.ts";

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture(rules = "", preset = "full-access") {
	const asked = vi.fn();
	const harness = await createHarness({
		extensionFlagValues: new Map([
			["permission", rules],
			["permission-preset", preset],
		]),
		extensionFactories: [
			permissionSystemExtension,
			(pi) => {
				pi.events.on("permission_asked", asked);
			},
		],
	});
	harnesses.push(harness);
	const runner = harness.getExtensionRunner();
	await runner.emit({ type: "session_start", reason: "startup" });
	const ctx = runner.createContext();
	const session = ctx.sessionManager;
	return { harness, runner, ctx, session, asked };
}

// senpi#4309: cell decisions must preserve the tool path's per-pattern deny projection.
it.each([
	{
		rules: "read:secret.txt=deny,read:/project/*=allow",
		tool: "read" as const,
		input: { path: "secret.txt" },
		denied: true,
	},
	{ rules: "bash:*=deny,bash:git *=allow", tool: "bash" as const, input: { command: "uname" }, denied: true },
	{ rules: "bash:*=deny,bash:git *=allow", tool: "bash" as const, input: { command: "git status" }, denied: false },
	{
		rules: "bash:uname=deny",
		tool: "bash" as const,
		input: { command: "git status; uname" },
		denied: true,
	},
	{
		rules: "external_directory:*=deny",
		tool: "write" as const,
		input: { path: "../outside.txt" },
		denied: true,
	},
])("matches tool denial for $rules / $input", async ({ rules, tool, input, denied }) => {
	const fx = await fixture(rules);
	const call: CellOperation = { tool, input, cwd: fx.ctx.cwd };
	const direct = await fx.runner.emitToolCall({
		type: "tool_call",
		toolCallId: "parity",
		toolName: tool,
		input,
	});
	expect(direct?.block === true).toBe(denied);
	expect(decideCellOperation(fx.session, call).action === "deny").toBe(denied);
});

it("uses the supplied execution cwd for external directory classification", async () => {
	const fx = await fixture("external_directory:*=deny");
	const call: CellOperation = { tool: "write", input: { path: "../outside.txt" }, cwd: "/project/elsewhere" };
	vi.spyOn(fx.runner, "createContext").mockReturnValue({ ...fx.ctx, cwd: call.cwd });
	const direct = await fx.runner.emitToolCall({
		type: "tool_call",
		toolCallId: "cwd",
		toolName: call.tool,
		input: call.input,
	});
	expect(decideCellOperation(fx.session, call).action === "deny").toBe(direct?.block === true);
});

it("returns the deciding rule and its layer", async () => {
	const fx = await fixture("read:secret.txt=deny");
	expect(decideCellOperation(fx.session, { tool: "read", input: { path: "secret.txt" }, cwd: fx.ctx.cwd })).toEqual({
		action: "deny",
		rule: { permission: "read", pattern: "secret.txt", layer: "cli" },
	});
});

it("publishes epochs for ordered user rule changes only while a deny applies", async () => {
	const fx = await fixture();
	const initial = cellEnforcementState(fx.session);
	expect(initial).toMatchObject({ alive: true, active: false });
	const changed = vi.fn();
	const unsubscribe = onCellEnforcementChange(fx.session, changed);
	fx.runner.setFlagValue("permission", "bash:git *=allow");
	expect(cellEnforcementState(fx.session).epoch).toBe(initial.epoch);
	fx.runner.setFlagValue("permission", "bash:*=deny,bash:git *=allow");
	const added = cellEnforcementState(fx.session);
	expect(added).toEqual({ alive: true, active: true, epoch: initial.epoch + 1 });
	fx.runner.setFlagValue("permission", "bash:*=deny");
	expect(cellEnforcementState(fx.session).epoch).toBe(added.epoch + 1);
	fx.runner.setFlagValue("permission-preset", "ask");
	expect(cellEnforcementState(fx.session).epoch).toBe(added.epoch + 2);
	fx.runner.setFlagValue("permission", "");
	expect(cellEnforcementState(fx.session)).toEqual({ alive: true, active: false, epoch: added.epoch + 3 });
	expect(changed).toHaveBeenCalledTimes(4);
	unsubscribe();
	await fx.runner.emit({ type: "session_shutdown", reason: "quit" });
	expect(changed).toHaveBeenCalledTimes(4);
	expect(cellEnforcementState(fx.session).alive).toBe(false);
});

it.each(["full-access", "ask"])("never asks for cell operations under %s", async (preset) => {
	const fx = await fixture("read:secret.txt=deny", preset);
	expect(decideCellOperation(fx.session, { tool: "bash", input: { command: "uname" }, cwd: fx.ctx.cwd })).toEqual({
		action: "pass",
	});
	expect(
		decideCellOperation(fx.session, { tool: "read", input: { path: "secret.txt" }, cwd: fx.ctx.cwd }).action,
	).toBe("deny");
	expect(fx.asked).not.toHaveBeenCalled();
});

it("fails closed without registration and after shutdown", async () => {
	expect(decideCellOperation({}, { tool: "ls", input: { path: "." }, cwd: "/project" })).toMatchObject({
		action: "deny",
		rule: { permission: "permission_authority", pattern: "unavailable", layer: "system" },
	});
	const fx = await fixture();
	await fx.runner.emit({ type: "session_shutdown", reason: "quit" });
	expect(decideCellOperation(fx.session, { tool: "ls", input: {}, cwd: fx.ctx.cwd }).action).toBe("deny");
});

it("fails closed when a preset reload fails", async () => {
	const fx = await fixture();
	fx.runner.setFlagValue("permission-preset", "invalid");
	expect(
		decideCellOperation(fx.session, { tool: "bash", input: { command: "uname" }, cwd: fx.ctx.cwd }),
	).toMatchObject({
		action: "deny",
		rule: { permission: "permission_authority", pattern: "setup_failed", layer: "system" },
	});
});
