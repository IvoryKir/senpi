import { afterEach, expect, it, vi } from "vitest";
import type { RecoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

type Rig = Awaited<ReturnType<typeof settledRig>>;

function settle(rig: Rig, content: string) {
	const ended = rig.end("user", content);
	rig.manager.appendOwnedMessage({ role: "user", content, timestamp: 1 }, { recoveryOwner: ended.carrier });
	const [append] = rig.manager.drainTranscript();
	if (append?.kind !== "append") throw new Error("no owned append");
	rig.lane.applyTranscript([append]);
	expect(rig.diagnostics).toEqual([]);
	return {
		...ended,
		entryId: append.id,
		owner: { kind: "owner", messageId: ended.carrier.messageId, entryId: append.id },
	};
}

function endOf(content: string) {
	return { type: "message_end", message: { role: "user", content, timestamp: 1 } };
}

// senpi#4460 MEDIUM: pruning a settled message's resident keys (carry item 9) must not erase the evidence that detects
// a repeat end or a second owner, or the durable join silently becomes many-to-one.
it("a replayed message_end carrying the settled entry is a duplicate_end, not a silent re-join", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const settled = settle(rig, "first");
		rig.lane.accept(settled.record, { ...settled.carrier, durableEntryId: settled.entryId });
		expect(rig.diagnostics).toEqual(["duplicate_end"]);
		const cut = await rig.cut();
		expect(cut.owners).toEqual([settled.owner]);
		expect(cut.settledMessages).toEqual([]);
	} finally {
		await rig.close();
	}
});

it("a replayed message_end without a durable entry after settle is rejected and writes no pending terminal", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const settled = settle(rig, "first");
		const bare: RecoveryCarrier = { messageId: settled.carrier.messageId, epoch: settled.carrier.epoch };
		rig.lane.accept(endOf("late"), bare);
		expect(rig.diagnostics).toEqual(["duplicate_end"]);
		const cut = await rig.cut();
		expect(cut.settledMessages).toEqual([]);
		expect(cut.owners).toEqual([settled.owner]);
	} finally {
		await rig.close();
	}
});

it("a second owned append after settle is a conflicting_owner and never rewrites the owner row", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const settled = settle(rig, "first");
		rig.manager.appendOwnedMessage(
			{ role: "user", content: "again", timestamp: 1 },
			{ recoveryOwner: settled.carrier },
		);
		const [second] = rig.manager.drainTranscript();
		if (second?.kind !== "append") throw new Error("no owned append");
		rig.lane.applyTranscript([second]);
		expect(rig.diagnostics).toEqual(["conflicting_owner"]);
		const cut = await rig.cut();
		expect(cut.owners).toEqual([settled.owner]);
		expect(await rig.lane.readSettled(cut.root)).toEqual({ settledMessages: [], owners: [settled.owner] });
	} finally {
		await rig.close();
	}
});

it("another message claiming a settled entry at its end is a conflicting_owner, so the join stays one-to-one", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const settled = settle(rig, "first");
		const claim: RecoveryCarrier = {
			messageId: "foreign-message",
			epoch: rig.lane.recoveryEpoch,
			durableEntryId: settled.entryId,
		};
		rig.lane.accept(endOf("claim"), claim);
		expect(rig.diagnostics).toEqual(["conflicting_owner"]);
		const cut = await rig.cut();
		expect(cut.owners).toEqual([settled.owner]);
		expect(cut.settledMessages).toEqual([]);
	} finally {
		await rig.close();
	}
});
