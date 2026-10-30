import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";

// Part of #4272 (S07a, R3.C6.4 T6-L5): with the compact-updates flag on, a shed freezes the cut C at the shed,
// keeps the pre-cut replies, and captures every post-C record behind the recovery baseline instead of dropping
// it; a suffix that overflows releases the cut and reads one fresh cut at the delivery. With the flag off the
// shed path is today's (issue-3728-live-peer-resync.test.ts).

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => vi.unstubAllEnvs());

const BUDGET = 360;
const start = { type: "message_start", message: { role: "assistant", content: "" } };
const update = (index: number) => ({
	type: "message_update",
	message: { role: "assistant", content: `${String(index).padStart(2, "0")}${"x".repeat(60)}` },
});
const shape = (lines: readonly string[]) =>
	lines.map((line) => {
		const record = JSON.parse(line) as {
			type: string;
			id?: string;
			message?: { content?: string } | null;
			reason?: string;
		};
		if (record.type === "message_update") return `update:${record.message?.content?.slice(0, 2)}`;
		if (record.type === "resync_required")
			return `resync:${record.reason}:${record.message?.content?.slice(0, 2) ?? "gap"}`;
		return record.id === undefined ? record.type : `${record.type}:${record.id}`;
	});

function resyncPeer(writer: SessionEventWriter, id: string) {
	const lines: string[] = [];
	const transport = Promise.withResolvers<void>();
	let released = false;
	const closed = vi.fn();
	writer.registerConnection(
		id,
		{
			writeRaw: (line) => void lines.push(line),
			waitForBackpressure: () => (released ? Promise.resolve() : transport.promise),
			close: closed,
		},
		{ maxQueueBytes: BUDGET },
	);
	writer.setConnectionCapabilities(id, [EVENT_RESYNC_CAPABILITY]);
	return {
		lines,
		closed,
		release: () => {
			released = true;
			transport.resolve();
		},
	};
}

it("T6-L5 shed: pre-cut replies, then the gap and the resync frozen at C, then the post-C suffix in order", async () => {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const peer = resyncPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "s");
	await writer.flush();
	// Given: the message start is in flight on the held transport; a reply and two updates fit the budget; update 3 overflows it.
	writer.enqueue("s", start);
	writer.withConnection("peer", () => writer.enqueue("s", { type: "response", id: "pre" }));
	for (let index = 1; index <= 3; index++) writer.enqueue("s", update(index));
	expect(lane.liveRoots, "the shed froze the cut").toBe(1);
	// When: the session keeps producing while the recovery is pending.
	writer.enqueue("s", update(4));
	writer.withConnection("peer", () => writer.enqueue("s", { type: "response", id: "post" }));
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual([
		"rpc_ping",
		"message_start",
		"response:pre",
		"resync:overflow:gap",
		"resync:overflow:03",
		"update:04",
		"response:post",
	]);
	expect(lane.liveRoots, "live roots after the recovery").toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	expect(peer.closed).not.toHaveBeenCalled();
	writer.unregisterConnection("peer");
});

it("T6-L5 supersede: a suffix that overflows releases the pending cut; one fresh cut is read at the delivery", async () => {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const freeze = vi.spyOn(lane, "freeze");
	const release = vi.spyOn(lane, "release");
	const peer = resyncPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "s");
	await writer.flush();
	expect(freeze, "the attach pinned and delivered its own (empty) baseline").toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalledTimes(1);
	writer.enqueue("s", start);
	for (let index = 1; index <= 3; index++) writer.enqueue("s", update(index));
	expect(freeze, "the shed froze C").toHaveBeenCalledTimes(2);
	// When: the captured suffix (4, 5) overflows at 6; 6 and 7 are dropped like today's path, not cut one by one.
	for (let index = 4; index <= 7; index++) writer.enqueue("s", update(index));
	expect(freeze, "no cut per overflowing record").toHaveBeenCalledTimes(2);
	expect(release, "the cut at C was released at the overflow").toHaveBeenCalledTimes(2);
	expect(lane.liveRoots).toBe(0);
	peer.release();
	await writer.flush();
	// Then: the one fresh cut read at the delivery covers everything dropped since C.
	expect(freeze, "one cut at the delivery").toHaveBeenCalledTimes(3);
	expect(shape(peer.lines)).toEqual(["rpc_ping", "message_start", "resync:overflow:gap", "resync:overflow:07"]);
	expect(release).toHaveBeenCalledTimes(3);
	expect(lane.liveRoots).toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
});

it("T6-L5 plain peer: a peer without event_resync still closes on overflow while a healthy sibling is unaffected", async () => {
	const writer = new SessionEventWriter(() => {});
	const plainLines: string[] = [];
	const plainClosed = vi.fn();
	const healthyLines: string[] = [];
	writer.registerConnection(
		"plain",
		{
			writeRaw: (line) => void plainLines.push(line),
			waitForBackpressure: () => new Promise<void>(() => {}),
			close: plainClosed,
		},
		{ maxQueueBytes: BUDGET },
	);
	writer.registerConnection("healthy", {
		writeRaw: (line) => void healthyLines.push(line),
		waitForBackpressure: async () => {},
	});
	writer.attachConnectionToSession("plain", "s");
	writer.attachConnectionToSession("healthy", "s");
	for (let index = 0; index <= 4; index++) writer.enqueue("s", update(index));
	await writer.flush();
	expect(plainClosed).toHaveBeenCalledTimes(1);
	expect(plainLines.at(-1)).toBe('{"type":"overflow","error":"overflow, resync required"}\n');
	expect(shape(healthyLines)).toEqual(["update:00", "update:01", "update:02", "update:03", "update:04"]);
	writer.unregisterConnection("healthy");
});
