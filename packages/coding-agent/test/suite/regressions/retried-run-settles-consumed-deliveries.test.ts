/**
 * A run that consumed a delivery, failed on the provider and was auto-retried starts the retry with no `idle()` in
 * between, so the deliveries it consumed must be settled when the next run starts. Before this, only a crash-recovered
 * (interrupted) run was settled there, and the retried run's `idle()` settled only itself: the first run's consumed
 * records stayed open and the session reported `waiting_background` with nothing running, forever.
 */
import { expect, it } from "vitest";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

function lifecycle(onCustodyWrite: () => void = () => {}): SessionLifecycleController {
	const manager = SessionManager.inMemory();
	return new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: [],
		append: (record) => manager.appendCustomEntry("session-lifecycle", record),
		appendChild: (record) => manager.appendCustomEntry("child-lifecycle", record),
		appendCustody: (record) => {
			onCustodyWrite();
			manager.appendCustomEntry("work-custody", record);
		},
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			holds: [],
			human: [],
		}),
	});
}

function consumeDeliveryIntoCurrentRun(controller: SessionLifecycleController, key: string): void {
	const runId = controller.ledger.runId;
	if (runId === undefined) throw new Error("expected a running lifecycle run");
	const ticket = controller.obligations.open(key, "background").ticket();
	controller.obligations.queue(ticket, {
		message: { customType: "senpi-terminal", content: "SETTLE-BG-42", display: true, details: undefined },
	});
	controller.obligations.consumed(ticket, { runId, transcriptEntryId: `entry-${key}` });
}

it("settles the deliveries a provider-failed run consumed when its auto-retry starts", () => {
	const controller = lifecycle();
	controller.restoreComplete();
	controller.startRun();
	consumeDeliveryIntoCurrentRun(controller, "delivery:senpi-terminal:notification:1");

	// The provider fails and auto-retry starts the next run: no idle() in between, and the run was not interrupted.
	controller.startRun("automatic");
	controller.idle();

	expect(controller.obligations.activeCount).toBe(0);
	expect(controller.snapshot.state).toBe("done");
});

it("a run that ends through idle() still settles its own consumed deliveries", () => {
	const controller = lifecycle();
	controller.restoreComplete();
	controller.startRun();
	consumeDeliveryIntoCurrentRun(controller, "delivery:omo-senpi:wake:1");
	controller.idle();

	expect(controller.obligations.activeCount).toBe(0);
	expect(controller.snapshot.state).toBe("done");
});

it("writes no custody record when a run starts and there is nothing to settle", () => {
	let custodyWrites = 0;
	const controller = lifecycle(() => {
		custodyWrites += 1;
	});
	controller.restoreComplete();
	controller.startRun();
	controller.idle();
	controller.startRun();
	controller.idle();

	expect(custodyWrites).toBe(0);
});
