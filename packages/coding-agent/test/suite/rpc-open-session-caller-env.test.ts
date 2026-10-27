import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

// senpi#4381: a caller passes a small explicit env to the ONE session it opens; the value reaches that
// session's tool subprocesses and nothing else on the host.
const PRINT_LANE = `printf "lane=%s" "\${OMOCAT_LANE-unset}"`;

afterEach(() => {
	vi.unstubAllEnvs();
});

it("gives a child opened with env { OMOCAT_LANE } that value in its tool subprocess", async () => {
	await using host = await contextHost();

	const opened = await host.open("conn-a", { env: { OMOCAT_LANE: "lane-alpha" } });

	expect(await host.bashOutput(String(opened.sessionId), PRINT_LANE)).toBe("lane=lane-alpha");
}, 120_000);

it("keeps two concurrent callers' values apart, and a later caller without the field sees none", async () => {
	await using host = await contextHost();

	const [alpha, beta] = await Promise.all([
		host.open("conn-a", { env: { OMOCAT_LANE: "lane-alpha" } }),
		host.open("conn-b", { env: { OMOCAT_LANE: "lane-beta" } }),
	]);
	const later = await host.open("conn-c", {});

	expect(await host.bashOutput(String(alpha.sessionId), PRINT_LANE)).toBe("lane=lane-alpha");
	expect(await host.bashOutput(String(beta.sessionId), PRINT_LANE)).toBe("lane=lane-beta");
	expect(await host.bashOutput(String(later.sessionId), PRINT_LANE)).toBe("lane=unset");
	expect(process.env.OMOCAT_LANE).toBeUndefined();
}, 120_000);

it("refuses a name that is not caller-passable with a typed error and opens nothing", async () => {
	await using host = await contextHost();

	const error = await host.openFailure("conn-a", { env: { DATABASE_URL: "postgres://nowhere" } });

	expect(error).toContain("invalid_session_env");
	expect(error).toContain("DATABASE_URL");
	expect(error).toContain("OMOCAT_LANE");
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("refuses a malformed env field (non-object, non-string value, bad name) with the same typed error", async () => {
	await using host = await contextHost();

	expect(await host.openFailure("conn-a", { env: "OMOCAT_LANE=x" })).toContain("invalid_session_env");
	expect(await host.openFailure("conn-a", { env: { OMOCAT_LANE: 7 } })).toContain("invalid_session_env");
	expect(await host.openFailure("conn-a", { env: { "omocat lane": "x" } })).toContain("invalid_session_env");
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);

it("passes the parent's OMOCAT_LANE to a task child opened with spawnedBy, end to end", async () => {
	await using host = await contextHost();

	const parent = await host.open("conn-parent", { env: { OMOCAT_LANE: "lane-parent" } });
	const parentState = z.object({ sessionId: z.string() }).parse(parent.state);
	const spawnedBy = { parentSessionId: parentState.sessionId, rootSessionId: parentState.sessionId, taskId: "t-1" };

	const child = await host.open("conn-child", { spawnedBy });
	const overridden = await host.open("conn-child-2", { spawnedBy, env: { OMOCAT_LANE: "lane-explicit" } });

	expect(await host.bashOutput(String(child.sessionId), PRINT_LANE)).toBe("lane=lane-parent");
	expect(await host.bashOutput(String(overridden.sessionId), PRINT_LANE)).toBe("lane=lane-explicit");
	expect(await host.bashOutput(String(parent.sessionId), PRINT_LANE)).toBe("lane=lane-parent");
}, 120_000);

it("gives a task child of a parent without a lane no lane, and ignores a parent this host does not run", async () => {
	await using host = await contextHost();

	const parent = await host.open("conn-parent", {});
	const parentState = z.object({ sessionId: z.string() }).parse(parent.state);
	const child = await host.open("conn-child", {
		spawnedBy: { parentSessionId: parentState.sessionId, rootSessionId: parentState.sessionId, taskId: "t-1" },
	});
	const orphan = await host.open("conn-orphan", {
		spawnedBy: { parentSessionId: "not-on-this-host", rootSessionId: "not-on-this-host", taskId: "t-2" },
	});

	expect(await host.bashOutput(String(child.sessionId), PRINT_LANE)).toBe("lane=unset");
	expect(await host.bashOutput(String(orphan.sessionId), PRINT_LANE)).toBe("lane=unset");
}, 120_000);

it("advertises session_env, the capability a client waits for before sending the field", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("session_env");
}, 120_000);
