import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { type CallsRig, callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q2-Q5, Q7): retirement joins, sweeps and nested children.

async function announced(rig: CallsRig, id: string, name = "bash") {
	const owner = rig.start();
	const call = fauxToolCall(name, { command: id }, { id });
	const started = rig.toolStart(owner, 0, call, name);
	rig.toolEnd(owner, 0, call, name);
	rig.end(owner, [call]);
	return { owner, call, started };
}

it("Q2 Q7 the carrier's settle retires the call with a full projection on the S05 row in the same step", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const { owner, started } = await announced(rig, "c1");
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "c1" } });
		rig.record({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "done", isError: false });
		const live = await rig.calls();
		rig.toolResult("c1", "bash", "done");
		const settled = await rig.calls();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		const key = `${live.root.sessionEpoch}:${started?.sequence}.0`;
		expect(live.calls.map((entry) => entry.runtimeItemKey)).toEqual([key]);
		expect(settled.calls).toEqual([]);
		expect(settled.sequence).toBe(settled.root.sequence);
		expect(row).toMatchObject({
			runtimeItemKey: key,
			call: {
				runtimeItemKey: key,
				toolCallId: "c1",
				turnId: started?.turnId,
				owningMessageId: owner.messageId,
				contentIndex: 0,
				parentKey: null,
				requestedName: "bash",
				resolvedName: "bash",
				input: { announced: { command: "c1" }, started: { command: "c1" }, prepared: null },
				startSequence: live.calls[0]?.startSequence,
				outcome: { kind: "result", isError: false, source: "execution_end" },
				nestedCalls: { calls: [], complete: true, omitted: 0 },
			},
		});
		expect(rig.lane.storageStatus().residentSettledKeys).toBeGreaterThan(0);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});

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

it("Q3 a never-started call retires at turn_end as an explicit not-executed terminal, never silently", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "never" }, { id: "n1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call], "error");
		const before = await rig.calls();
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		const after = await rig.calls();
		expect(before.calls[0]).toMatchObject({ phase: "awaiting-execution", outcome: null });
		expect(after.calls[0]).toMatchObject({
			runtimeItemKey: before.calls[0]?.runtimeItemKey,
			phase: "completed-awaiting-entry",
			outcome: { kind: "not-executed" },
			join: "carrierless",
		});
		expect(after.counters.carrierless).toBe(1);
		rig.record({ type: "agent_settled" });
		expect((await rig.calls()).calls[0]?.outcome).toEqual({ kind: "not-executed" });
		rig.lane.release(before.root);
		rig.lane.release(after.root);
	} finally {
		await rig.close();
	}
});

it("Q4 a started call with no carrier is abandoned at agent_settled and a late real end replaces the outcome", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "br", toolName: "bash", args: { command: "x" } });
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		rig.record({ type: "agent_end", messages: [] });
		rig.record({ type: "agent_settled" });
		const abandoned = await rig.calls();
		const late = rig.record({
			type: "tool_execution_end",
			toolCallId: "br",
			toolName: "bash",
			result: "r",
			isError: true,
		});
		const ended = await rig.calls();
		expect(abandoned.calls[0]).toMatchObject({
			owningMessageId: null,
			join: "carrierless",
			outcome: { kind: "abandoned" },
		});
		expect(late).toBeDefined();
		expect(ended.calls[0]).toMatchObject({
			phase: "completed-awaiting-entry",
			join: "carrierless",
			result: "r",
			outcome: { kind: "result", isError: true, source: "execution_end" },
		});
		expect(ended.counters).toMatchObject({ live: 1, carrierless: 1 });
		rig.lane.release(abandoned.root);
		rig.lane.release(ended.root);
	} finally {
		await rig.close();
	}
});

it("Q5 completed nested children ride on the parent projection and an executing one ends carrierless as an orphan", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		await announced(rig, "p1", "codemode");
		rig.record({ type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: { command: "p1" } });
		for (const id of ["p1/1", "p1/2"])
			rig.record({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "read",
				args: { id },
				parentToolCallId: "p1",
			});
		rig.record({ type: "tool_execution_end", toolCallId: "p1/1", toolName: "read", result: "r1", isError: false });
		const nested = await rig.calls();
		rig.record({ type: "tool_execution_end", toolCallId: "p1", toolName: "codemode", result: "ok", isError: false });
		rig.toolResult("p1", "codemode", "ok");
		const settled = await rig.calls();
		const parentKey = nested.calls.find((entry) => entry.toolCallId === "p1")?.runtimeItemKey;
		expect(nested.calls.filter((entry) => entry.parentKey === parentKey).map((entry) => entry.toolCallId)).toEqual([
			"p1/1",
			"p1/2",
		]);
		expect(nested.calls.find((entry) => entry.toolCallId === "p1/1")?.owningMessageId).toBeNull();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: parentKey,
			nestedCalls: { calls: [{ toolCallId: "p1/1", outcome: { kind: "result", isError: false } }], complete: false },
		});
		expect(settled.calls.map((entry) => [entry.toolCallId, entry.phase, entry.join])).toEqual([
			["p1/2", "executing", "pending"],
		]);
		rig.record({ type: "tool_execution_end", toolCallId: "p1/2", toolName: "read", result: "r2", isError: false });
		expect((await rig.calls()).calls[0]).toMatchObject({ phase: "completed-awaiting-entry", join: "carrierless" });
		rig.lane.release(nested.root);
		rig.lane.release(settled.root);
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

it("senpi#4278 two overlapping calls with one reused id each end in creation order and no end is late", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const start = { type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: {} };
		const first = rig.record(start);
		const second = rig.record(start);
		const end = { type: "tool_execution_end", toolCallId: "n1", toolName: "read", isError: false };
		expect(rig.record({ ...end, result: "a" })).toBeDefined();
		const between = await rig.calls();
		expect(rig.record({ ...end, result: "b" })).toBeDefined();
		const ended = await rig.calls();
		expect(rig.record({ ...end, result: "c" }), "a third end has no call left to close").toBeUndefined();
		const again = await rig.calls();
		const epoch = ended.root.sessionEpoch;
		const shape = (entry: { runtimeItemKey: string; phase: string; result: unknown }) => [
			entry.runtimeItemKey,
			entry.phase,
			entry.result,
		];
		expect(between.calls.map(shape)).toEqual([
			[`${epoch}:${first?.sequence}.0`, "completed-awaiting-entry", "a"],
			[`${epoch}:${second?.sequence}.0`, "executing", null],
		]);
		expect(ended.calls.map(shape)).toEqual([
			[`${epoch}:${first?.sequence}.0`, "completed-awaiting-entry", "a"],
			[`${epoch}:${second?.sequence}.0`, "completed-awaiting-entry", "b"],
		]);
		expect(ended.counters).toMatchObject({ reused: 1, ignored: { unknown: 0, late: 0 } });
		expect(again.root.sequence).toBe(ended.root.sequence);
		expect(again.counters.ignored).toEqual({ unknown: 0, late: 1 });
		for (const cut of [between, ended, again]) rig.lane.release(cut.root);
	} finally {
		await rig.close();
	}
});

it("RULING-13 an unannounced start has a null owning message and a parentKey resolved from parentToolCallId", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const parent = rig.record({ type: "tool_execution_start", toolCallId: "u1", toolName: "codemode", args: {} });
		const child = { type: "tool_execution_start", toolName: "read", args: {} };
		rig.record({ ...child, toolCallId: "u1/1", parentToolCallId: "u1" });
		rig.record({ ...child, toolCallId: "o1", parentToolCallId: "ghost" });
		const live = await rig.calls();
		const parentKey = `${live.root.sessionEpoch}:${parent?.sequence}.0`;
		expect(live.calls.map((entry) => [entry.toolCallId, entry.owningMessageId, entry.parentKey])).toEqual([
			["u1", null, null],
			["u1/1", null, parentKey],
			["o1", null, null],
		]);
		const end = { type: "tool_execution_end", toolName: "read", result: "r", isError: false };
		rig.record({ ...end, toolCallId: "u1/1" });
		rig.record({ ...end, toolCallId: "u1" });
		rig.toolResult("u1", "codemode", "r");
		const settled = await rig.calls();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: parentKey,
			owningMessageId: null,
			parentKey: null,
			nestedCalls: { calls: [{ toolCallId: "u1/1", owningMessageId: null, parentKey }], complete: true, omitted: 0 },
		});
		expect(settled.calls.map((entry) => entry.toolCallId)).toEqual(["o1"]);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});
