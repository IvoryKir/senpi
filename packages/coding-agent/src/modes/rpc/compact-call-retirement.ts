import {
	type CallProjection,
	NESTED_PROJECTION_LIMIT,
	type OutstandingCall,
	TERMINAL_PHASE,
	terminal,
} from "./compact-call-model.ts";
import type { CompactCallTable } from "./compact-call-table.ts";

/** The reader fields a retired call leaves behind: everything but its phase, join and owned slots (RULING-13 Q2). */
function projectionOf(call: OutstandingCall): Omit<CallProjection, "nestedCalls"> {
	const { phase: _phase, join: _join, raw: _raw, hook: _hook, progress: _progress, result: _result, ...fields } = call;
	return fields;
}

/**
 * The carrier settled: the call and its completed children leave the table with one projection. Children beyond
 * `NESTED_PROJECTION_LIMIT` (the parent's own nested-call record bound, RULING-13 Q5) mark the projection incomplete.
 */
export function settleCall(table: CompactCallTable, call: OutstandingCall, isError: boolean): CallProjection {
	const settled: OutstandingCall = terminal(call)
		? call
		: { ...call, phase: TERMINAL_PHASE, outcome: { kind: "result", isError, source: "result_message" } };
	const children = table.childrenOf(call.runtimeItemKey);
	const completed = children.filter(terminal);
	const projection: CallProjection = {
		...projectionOf(settled),
		nestedCalls: {
			calls: completed.slice(0, NESTED_PROJECTION_LIMIT).map((child) => ({
				...projectionOf(child),
				nestedCalls: { calls: [], complete: true },
			})),
			complete: completed.length === children.length && children.length <= NESTED_PROJECTION_LIMIT,
		},
	};
	for (const child of completed) table.remove(child.runtimeItemKey);
	table.remove(call.runtimeItemKey);
	return projection;
}

export const NOT_EXECUTED: Partial<OutstandingCall> = {
	phase: TERMINAL_PHASE,
	outcome: { kind: "not-executed" },
	join: "carrierless",
};

/** RULING-13 Q3/Q4: the sweep patch for one call once no carrier can arrive; `undefined` leaves it alone. */
export function settledPatch(call: OutstandingCall): Partial<OutstandingCall> | undefined {
	if (call.startSequence === null && !terminal(call)) return NOT_EXECUTED;
	if (call.phase === "executing")
		return call.parentKey === null
			? { phase: TERMINAL_PHASE, outcome: { kind: "abandoned" }, join: "carrierless" }
			: undefined;
	return call.join === "pending" ? { join: "carrierless" } : undefined;
}
