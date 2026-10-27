import { afterEach, expect, it, vi } from "vitest";
import { type RecoveryCarrier, recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { settledRig } from "./4272-settled-support.ts";

afterEach(() => vi.unstubAllEnvs());

// senpi#4272 carry item 9: a long session's settled messages leave no resident membership behind. Only messages that
// are not settled yet (ended and unjoined, or joined before their end) keep keys, so the footprint follows the
// in-flight window, not the session length; the joins themselves stay readable from the paged rows.
it("item 9 resident settled keys stay bounded across a long session in both join orders", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const rig = await settledRig();
	try {
		const join = (carrier: RecoveryCarrier, content: string) => {
			rig.manager.appendOwnedMessage({ role: "user", content, timestamp: 1 }, { recoveryOwner: carrier });
			rig.lane.applyTranscript(rig.manager.drainTranscript());
		};
		let peak = 0;
		for (let index = 0; index < 300; index++) {
			const content = `m${index}`;
			if (index % 2 === 0) join(rig.end("user", content).carrier, content);
			else {
				const record = { type: "message_end", message: { role: "user", content, timestamp: 1 } };
				rig.producer.observe(record);
				const carrier = recoveryCarrier(record);
				if (!carrier) throw new Error("producer failed to mint");
				join(carrier, content);
				peak = Math.max(peak, rig.lane.storageStatus().residentSettledKeys);
				rig.lane.accept(record, carrier);
			}
			peak = Math.max(peak, rig.lane.storageStatus().residentSettledKeys);
		}
		expect(rig.lane.storageStatus().residentSettledKeys).toBe(0);
		expect(peak, "an append before its end holds only that message's keys").toBe(2);
		const unjoined = rig.end("user", "never persisted");
		expect(rig.lane.storageStatus().residentSettledKeys).toBe(2);
		rig.lane.accept({ type: "message_end", message: { role: "user", content: "again" } }, unjoined.carrier);
		expect(rig.diagnostics).toEqual(["duplicate_end"]);
		const cut = await rig.cut();
		expect(cut.owners).toHaveLength(300);
		expect(cut.settledMessages.map((row) => row.messageId)).toEqual([unjoined.carrier.messageId]);
	} finally {
		await rig.close();
	}
});
