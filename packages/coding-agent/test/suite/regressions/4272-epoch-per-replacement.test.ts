import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { type WireRecord, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Host = Awaited<ReturnType<typeof workerAcceptanceHost>>;
type AcceptedRef = NonNullable<ReturnType<SessionAcceptanceLane["accept"]>>;
type Replacement = "new_session" | "fork" | "switch_session";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function prompt(host: Host, sessionId: string): Promise<void> {
	const settled = host.next("agent_settled", (record) => record.type === "agent_settled");
	expect((await host.request({ type: "prompt", sessionId, message: "question" })).success).toBe(true);
	await settled;
}

function replacementCommand(kind: Replacement, host: Host, sessionId: string): { type: string } & WireRecord {
	if (kind === "new_session") return { type: "new_session", sessionId };
	if (kind === "fork") {
		const lines = readFileSync(String(host.registry.peek(sessionId)?.sessionPath), "utf8")
			.trim()
			.split("\n");
		const user = lines
			.map((line): { id?: string; type?: string; message?: { role?: string } } => JSON.parse(line))
			.find((entry) => entry.type === "message" && entry.message?.role === "user");
		if (!user?.id) throw new Error("the prompt persisted no user entry to fork from");
		return { type: "fork", sessionId, entryId: user.id };
	}
	const target = join(host.dir, "switch-target.jsonl");
	const header = { type: "session", version: 3, id: "switch-target", timestamp: new Date(0).toISOString() };
	writeFileSync(target, `${JSON.stringify({ ...header, cwd: host.dir })}\n`);
	return { type: "switch_session", sessionId, sessionPath: target };
}

/**
 * A real worker session accepts one turn, is replaced through `kind`, then accepts another turn. Every
 * AcceptedRef the host lane returns is kept in order; `atReplaced` counts those accepted before the
 * replacement record reached the client.
 */
async function acrossReplacement(kind: Replacement) {
	vi.stubEnv(FLAG, "1");
	const refs: AcceptedRef[] = [];
	const accept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		record,
		carrier,
	) {
		const ref = accept.call(this, record, carrier);
		if (ref) refs.push(ref);
		return ref;
	});
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		await prompt(host, sessionId);
		const before = lane.freeze();
		let atReplaced = -1;
		const replaced = host.next("session_replaced", (record) => {
			if (record.type === "session_replaced") atReplaced = refs.length;
			return record.type === "session_replaced";
		});
		const response = await host.request(replacementCommand(kind, host, sessionId));
		expect(response.success, JSON.stringify(response)).toBe(true);
		await replaced;
		const after = lane.freeze();
		await prompt(host, sessionId);
		const firstNew = refs.findIndex((ref) => ref.sessionEpoch !== before.sessionEpoch);
		expect(firstNew, "no ref of the new epoch before the replacement, none of the old one after").toBe(atReplaced);
		const result = { before, after, oldRefs: refs.slice(0, firstNew), newRefs: refs.slice(firstNew) };
		lane.release(before);
		lane.release(after);
		expect(lane.liveRoots).toBe(0);
		return result;
	} finally {
		await host.dispose();
	}
}

function expectNewEpoch({ before, after, oldRefs, newRefs }: Awaited<ReturnType<typeof acrossReplacement>>): void {
	expect(before.sessionEpoch).toMatch(UUID);
	expect(after.sessionEpoch, "the replacement minted a new epoch").toMatch(UUID);
	expect(after.sessionEpoch).not.toBe(before.sessionEpoch);
	expect(after.sequence, "the new epoch starts from its bootstrap").toBe(0);
	expect(after.transcript.count, "no accepted append crosses into the new epoch").toBe(0);
	expect(oldRefs.length).toBeGreaterThan(2);
	expect(oldRefs.every((ref) => ref.sessionEpoch === before.sessionEpoch)).toBe(true);
	expect(newRefs.length).toBeGreaterThan(2);
	expect(
		newRefs.every((ref) => ref.sessionEpoch === after.sessionEpoch),
		"every later ref names the new epoch",
	).toBe(true);
	for (const [index, ref] of newRefs.entries())
		if (index > 0) expect(ref.sequence).toBeGreaterThan(newRefs[index - 1]?.sequence ?? 0);
	// Sequences restart per epoch, so an ordering across the boundary exists only through the epoch.
	expect(newRefs[0]?.sequence, "the new epoch's sequence restarted").toBe(1);
	expect(newRefs[0]?.sequence ?? 0).toBeLessThan(oldRefs.at(-1)?.sequence ?? 0);
	expect(before.sequence, "the old cut stays inside its own epoch's numbering").toBeLessThanOrEqual(
		oldRefs.at(-1)?.sequence ?? 0,
	);
}

// Part of #4272, ruling 10 Q2: replacement, fork and switch each start a new AgentSession incarnation.
it("Q2 replace: new_session mints a new sessionEpoch and its sequences are never compared with the old epoch", async () => {
	expectNewEpoch(await acrossReplacement("new_session"));
}, 120_000);

it("Q2 fork: fork mints a new sessionEpoch and its sequences are never compared with the old epoch", async () => {
	expectNewEpoch(await acrossReplacement("fork"));
}, 120_000);

it("Q2 switch: switch_session mints a new sessionEpoch and its sequences are never compared with the old epoch", async () => {
	expectNewEpoch(await acrossReplacement("switch_session"));
}, 120_000);
