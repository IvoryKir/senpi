import { expect, it } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";

type End = "takeSnapshot" | "session_close" | "error" | "peer_drop";

/**
 * One resync-capable peer whose transport is held full, so the next records overflow its queue and the actor
 * sheds. `end` then finishes that shed through one path; `lane` is registered only when given.
 */
async function shedThenEnd(end: End, lane?: SessionAcceptanceLane) {
	const writes: string[] = [];
	const transport = Promise.withResolvers<void>();
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection(
		"peer",
		{ writeRaw: (line) => writes.push(line), waitForBackpressure: () => transport.promise },
		{ maxQueueBytes: 400 },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	writer.attachConnectionToSession("peer", "s");
	if (lane) writer.registerAcceptance("s", lane);
	for (let index = 0; index < 8; index++)
		writer.enqueue("s", { type: "message_update", message: { role: "assistant", content: "x".repeat(60) }, index });
	const liveDuringShed = lane?.liveRoots;
	if (end === "takeSnapshot") {
		transport.resolve();
		await writer.flushConnection("peer");
	} else if (end === "error") {
		transport.reject(new Error("peer transport failed"));
		await writer.flushConnection("peer").catch(() => undefined);
	} else if (end === "peer_drop") writer.unregisterConnection("peer");
	else writer.closeSession("s", { type: "response", command: "close_session", success: true });
	const liveAfter = lane?.liveRoots;
	writer.unregisterConnection("peer");
	return { writes, liveDuringShed, liveAfter };
}

// Part of #4272, ruling 10 Q1: the event-resync shed is freeze's real caller; its root is released on every end.
it.each<End>(["takeSnapshot", "session_close", "error", "peer_drop"])(
	"Q1 releases the shed's frozen root on %s and leaves zero live roots",
	async (end) => {
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ leafId: null });
		const { liveDuringShed, liveAfter } = await shedThenEnd(end, lane);
		expect(liveDuringShed, "the shed froze the attached session's root before awaiting the drain").toBe(1);
		expect(liveAfter, `live roots after ${end}`).toBe(0);
	},
);

it("Q1 keeps the resync bytes, reasons and order the peer received without a lane", async () => {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ leafId: null });
	const withLane = await shedThenEnd("takeSnapshot", lane);
	const without = await shedThenEnd("takeSnapshot");
	expect(withLane.writes.some((line) => line.includes('"type":"resync_required"'))).toBe(true);
	expect(withLane.writes).toEqual(without.writes);
});
