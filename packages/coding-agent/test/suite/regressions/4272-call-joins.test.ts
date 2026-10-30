import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13): joins by id between the execution and announcement sides.

it("C3.3 an out-of-order announcement joins a started call by id without changing its phase or key", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const bridge = rig.record({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "x" },
		});
		const call = fauxToolCall("bash", { command: "x" }, { id: "b1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.record({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: "r", isError: false });
		rig.end(owner, [call]);
		const view = await rig.calls();
		expect(view.calls).toHaveLength(1);
		expect(view.calls[0]).toMatchObject({
			runtimeItemKey: `${view.root.sessionEpoch}:${bridge?.sequence}.0`,
			phase: "completed-awaiting-entry",
			owningMessageId: owner.messageId,
			contentIndex: 0,
			input: { announced: { command: "x" }, started: { command: "x" } },
		});
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("C3 cond. 3 a call joined after a bridged start streams its raw prefix through the active block until its end", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		rig.record({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "x" } });
		const call = fauxToolCall("bash", { command: "x" }, { id: "b1" });
		const raw = JSON.stringify({ command: "x" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolDelta(owner, 0, 0, raw.slice(0, 5));
		const streaming = await rig.calls();
		rig.toolDelta(owner, 0, 5, raw.slice(5));
		rig.toolEnd(owner, 0, call, "bash");
		const announced = await rig.calls();
		expect(streaming.calls).toHaveLength(1);
		expect(streaming.calls[0]).toMatchObject({
			phase: "executing",
			owningMessageId: owner.messageId,
			contentIndex: 0,
			raw: raw.slice(0, 5),
		});
		expect(announced.calls[0]).toMatchObject({ phase: "executing", raw });
		rig.lane.release(streaming.root);
		rig.lane.release(announced.root);
	} finally {
		await rig.close();
	}
});

it("senpi#4278 a repeated nested id mints a fresh key and counts the reuse", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: {} });
		const first = rig.record({
			type: "tool_execution_start",
			toolCallId: "p1/1",
			toolName: "read",
			args: {},
			parentToolCallId: "p1",
		});
		rig.record({ type: "tool_execution_end", toolCallId: "p1/1", toolName: "read", result: "a", isError: false });
		const second = rig.record({
			type: "tool_execution_start",
			toolCallId: "p1/1",
			toolName: "read",
			args: {},
			parentToolCallId: "p1",
		});
		const view = await rig.calls();
		const keys = view.calls.filter((entry) => entry.toolCallId === "p1/1").map((entry) => entry.runtimeItemKey);
		expect(keys).toEqual([
			`${view.root.sessionEpoch}:${first?.sequence}.0`,
			`${view.root.sessionEpoch}:${second?.sequence}.0`,
		]);
		expect(view.counters.reused).toBe(1);
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});
