/**
 * senpi#4324: the observing, activity-neutral and new-work lists are derived from the method table, and every inbound
 * record type has a validator built from one schema.
 */
import { describe, expect, it } from "vitest";
import { isObservingRequest } from "../../../src/modes/rpc/host-observe-request.ts";
import { HostIdleHandover } from "../../../src/modes/rpc/host-idle-handover.ts";
import type { RpcInboundRecord } from "../../../src/modes/rpc/rpc-host-command-types.ts";
import {
	RPC_INBOUND_SCHEMAS,
	RPC_QUESTION_ANSWER_LIMITS,
	validateRpcInboundRecord,
} from "../../../src/modes/rpc/rpc-inbound-schema.ts";
import {
	RPC_ACTIVITY_NEUTRAL_METHODS,
	RPC_METHOD_CLASS,
	RPC_METHOD_TRAITS,
	rpcMethodBaseClass,
	RPC_NEW_WORK_METHODS,
	RPC_OBSERVING_METHODS,
	type RpcMethodType,
} from "../../../src/modes/rpc/rpc-method-class.ts";
import { refreshesSessionActivity } from "../../../src/modes/rpc/session-command-activity.ts";

type RecordOf<K extends RpcMethodType> = Extract<RpcInboundRecord, { type: K }>;

const ENTRY = {
	type: "message",
	id: "e1",
	parentId: null,
	timestamp: "2026-10-26T00:00:00.000Z",
	message: { role: "user", content: "hi", timestamp: 0 },
} as const;

/** One well-typed record per inbound type. Typed over `RpcInboundRecord["type"]`, so a new type needs a sample. */
const SAMPLES: { readonly [K in RpcMethodType]: RecordOf<K> } = {
	get_protocol_info: { type: "get_protocol_info", auth: { client_nonce: "n" }, observe: true },
	open_session: { type: "open_session", cwd: "/w", kind: "worker", context: { k: "v" }, thinkingLevel: "high" },
	close_session: { type: "close_session", sessionId: "s" },
	move_session: { type: "move_session", op: "export", sessionPath: "/p", moveId: "m", target: "t" },
	release_session: { type: "release_session", sessionId: "s", reason: "takeover" },
	unload_session: { type: "unload_session", sessionId: "s", children: "detach" },
	detach_connection: { type: "detach_connection" },
	get_subscription_limits: { type: "get_subscription_limits" },
	get_rpc_method_classes: { type: "get_rpc_method_classes", observe: true },
	list_sessions: { type: "list_sessions", include_workers: true },
	subscribe_sessions: { type: "subscribe_sessions", sessions: { childrenOf: "d" }, mirror: ["message_end"] },
	unsubscribe_sessions: { type: "unsubscribe_sessions", subscriptionId: "sub" },
	set_session_context: { type: "set_session_context", sessionId: "s", patch: { a: "b", n: 1, f: false, x: null } },
	warm: { type: "warm", cwd: "/w" },
	attach_session: { type: "attach_session", sessionId: "s", durableSessionId: "d" },
	release_attachment: { type: "release_attachment", sessionId: "s" },
	reclaim_session: { type: "reclaim_session", sessionPath: "/p", durableSessionId: "d", expectedHostInstance: "h" },
	extension_ui_response: { type: "extension_ui_response", id: "u", answers: { q: { selected: ["a"] } } },
	extension_ui_progress: { type: "extension_ui_progress", id: "u", answers: { q: { selected: [], text: "t" } } },
	host_response: { type: "host_response", id: "r", data: { any: 1 } },
	prompt: { type: "prompt", message: "hi", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
	release_tool_barrier: { type: "release_tool_barrier", barrierId: "b" },
	send_custom_message: { type: "send_custom_message", customType: "c", content: "x", display: true },
	continue_from_leaf: { type: "continue_from_leaf" },
	resume_session: { type: "resume_session", mode: "continue" },
	append_user_message: { type: "append_user_message", content: "hi" },
	append_session_entry: { type: "append_session_entry", entry: ENTRY },
	steer: { type: "steer", message: "m", whenIdle: "start", clientMessageId: "c" },
	follow_up: { type: "follow_up", message: "m", enqueueOrder: 1 },
	abort: { type: "abort", awaitIdle: true, intent: "stop" },
	interrupt: { type: "interrupt", turnId: "t" },
	hold_input: { type: "hold_input", inputId: "i", revision: 1, text: "t" },
	withdraw_held_input: { type: "withdraw_held_input", inputId: "i" },
	pause_for_run: { type: "pause_for_run", parentSessionId: "p", parentPauseSeq: 1, runRef: { kind: "task", id: "t" } },
	resume_for_run: {
		type: "resume_for_run",
		parentSessionId: "p",
		parentPauseSeq: 1,
		resumeId: "r",
		childSeqCutoff: 2,
	},
	abort_compaction: { type: "abort_compaction" },
	reload: { type: "reload" },
	check_reload_veto: { type: "check_reload_veto" },
	clear_queue: { type: "clear_queue", abortWillFollow: true },
	dequeue_message: { type: "dequeue_message", queuedId: "q" },
	edit_queued_message: { type: "edit_queued_message", queuedId: "q", text: "t", expectedRevision: 2 },
	get_steering_messages: { type: "get_steering_messages" },
	get_follow_up_messages: { type: "get_follow_up_messages" },
	abort_branch_summary: { type: "abort_branch_summary" },
	new_session: { type: "new_session" },
	wake: { type: "wake", delivery_ids: ["d"] },
	get_state: { type: "get_state", sessionId: "s" },
	get_snapshot: { type: "get_snapshot", tail: 10 },
	request_self_settle: { type: "request_self_settle" },
	get_effect_status: { type: "get_effect_status", effectId: "e" },
	get_pending_inputs: { type: "get_pending_inputs", knownClientMessageIds: ["c"] },
	set_model: { type: "set_model", provider: "p", modelId: "m" },
	set_favorite_models: { type: "set_favorite_models", models: [] },
	set_scoped_models: { type: "set_scoped_models", models: [] },
	cycle_model: { type: "cycle_model", direction: "backward" },
	get_available_models: { type: "get_available_models" },
	set_thinking_level: { type: "set_thinking_level", level: "max", scope: "turn" },
	cycle_thinking_level: { type: "cycle_thinking_level" },
	get_available_thinking_levels: { type: "get_available_thinking_levels" },
	get_model_thinking_level: { type: "get_model_thinking_level", provider: "p", modelId: "m" },
	set_fast_mode: { type: "set_fast_mode", enabled: false },
	get_fast_mode: { type: "get_fast_mode" },
	set_steering_mode: { type: "set_steering_mode", mode: "one-at-a-time" },
	set_follow_up_mode: { type: "set_follow_up_mode", mode: "all" },
	compact: { type: "compact" },
	set_auto_compaction: { type: "set_auto_compaction", enabled: true },
	set_auto_retry: { type: "set_auto_retry", enabled: true },
	abort_retry: { type: "abort_retry" },
	set_retry_fallback: {
		type: "set_retry_fallback",
		retryFallback: { modelFallback: true, fallbackChains: { "a/b": ["c/d"] } },
	},
	bash: { type: "bash", command: "true" },
	record_bash_result: {
		type: "record_bash_result",
		command: "true",
		result: { output: "", exitCode: 0, cancelled: false, truncated: false },
	},
	abort_bash: { type: "abort_bash" },
	cleanup_bash_output: { type: "cleanup_bash_output", path: "/tmp/x" },
	set_label: { type: "set_label", entryId: "e" },
	navigate_tree: { type: "navigate_tree", entryId: "e", intent: "resume" },
	get_session_stats: { type: "get_session_stats" },
	resolve_path: { type: "resolve_path", path: "~/x" },
	memory_report: { type: "memory_report" },
	export_html: { type: "export_html" },
	export_jsonl: { type: "export_jsonl", outputPath: "/o" },
	switch_session: { type: "switch_session", sessionPath: "/p" },
	fork: { type: "fork", entryId: "e", position: "at" },
	edit_assistant_message: { type: "edit_assistant_message", entryId: "e", text: "t" },
	edit_user_message: { type: "edit_user_message", entryId: "e", text: "t", summarize: true },
	clone: { type: "clone" },
	get_fork_messages: { type: "get_fork_messages" },
	get_entries: { type: "get_entries", tail: 5, maxBytes: 1024 },
	get_tree: { type: "get_tree" },
	get_last_assistant_text: { type: "get_last_assistant_text" },
	set_session_name: { type: "set_session_name", name: "n" },
	record_user_activity: { type: "record_user_activity", kind: "draft" },
	import_jsonl: { type: "import_jsonl", inputPath: "/i" },
	get_messages: { type: "get_messages" },
	get_media: { type: "get_media", toolCallId: "t", contentIndex: 0 },
	get_commands: { type: "get_commands" },
	get_loaded_surfaces: { type: "get_loaded_surfaces" },
	extension_request: { type: "extension_request", name: "n", data: [1] },
	"eval_cells.list": { type: "eval_cells.list" },
	"eval_cells.peek": { type: "eval_cells.peek", cellId: "c", tailBytes: 10 },
	"eval_cells.stop": { type: "eval_cells.stop", cellId: "c" },
	get_auth_providers: { type: "get_auth_providers" },
	login_start: { type: "login_start", provider: "p" },
	login_cancel: { type: "login_cancel", provider: "p" },
	login_api_key: { type: "login_api_key", provider: "p", key: "k" },
	logout: { type: "logout", provider: "p" },
	verify_api_key: { type: "verify_api_key", provider: "p", key: "k" },
	get_provider_accounts: { type: "get_provider_accounts", provider: "p" },
	account_pin: { type: "account_pin", provider: "p", name: null },
	account_remove: { type: "account_remove", provider: "p", name: "n" },
	account_order: { type: "account_order", provider: "p", names: ["a"] },
	set_client_info: { type: "set_client_info", width: 80, capabilities: ["c"] },
};

const EVERY_TYPE = Object.keys(SAMPLES) as RpcMethodType[];

const sorted = (methods: ReadonlySet<string>): string[] => [...methods].sort();

describe("senpi#4324 lists derived from the method table", () => {
	it("pins the observing set", () => {
		expect(sorted(RPC_OBSERVING_METHODS)).toEqual(
			[
				"get_effect_status",
				"get_entries",
				"get_pending_inputs",
				"get_protocol_info",
				"get_rpc_method_classes",
				"get_snapshot",
				"get_state",
				"get_subscription_limits",
				"list_sessions",
				"subscribe_sessions",
				"unsubscribe_sessions",
			].sort(),
		);
	});

	it("pins the activity-neutral set: every observe method plus the read-only device reads", () => {
		expect(sorted(RPC_ACTIVITY_NEUTRAL_METHODS)).toEqual(
			[
				"eval_cells.list",
				"eval_cells.peek",
				"get_auth_providers",
				"get_available_models",
				"get_available_thinking_levels",
				"get_commands",
				"get_effect_status",
				"get_entries",
				"get_fast_mode",
				"get_follow_up_messages",
				"get_fork_messages",
				"get_last_assistant_text",
				"get_loaded_surfaces",
				"get_media",
				"get_messages",
				"get_model_thinking_level",
				"get_pending_inputs",
				"get_protocol_info",
				"get_provider_accounts",
				"get_rpc_method_classes",
				"get_session_stats",
				"get_snapshot",
				"get_state",
				"get_steering_messages",
				"get_subscription_limits",
				"get_tree",
				"list_sessions",
				"memory_report",
				"resolve_path",
			].sort(),
		);
	});

	it("pins the new-work set", () => {
		expect(sorted(RPC_NEW_WORK_METHODS)).toEqual(
			[
				"append_user_message",
				"bash",
				"compact",
				"continue_from_leaf",
				"edit_assistant_message",
				"edit_user_message",
				"follow_up",
				"prompt",
				"resume_session",
				"send_custom_message",
				"steer",
				"wake",
			].sort(),
		);
	});

	it("keeps every trait on a class it can be true of", () => {
		const allowed: Record<string, readonly string[]> = {
			observing_read: ["observe", "connection_local"],
			read_only: ["device_admin"],
			new_work: ["drive", "thread", "device_admin"],
		};
		for (const type of EVERY_TYPE) {
			const methodClass = rpcMethodBaseClass(type);
			for (const trait of RPC_METHOD_TRAITS[type])
				expect(allowed[trait], `${type}: ${trait}`).toContain(methodClass);
		}
	});

	it("drives the supervisor's observe check from the derived set", () => {
		for (const type of EVERY_TYPE) {
			if (type === "warm") continue;
			expect(isObservingRequest(JSON.stringify({ type, observe: true })), type).toBe(
				RPC_OBSERVING_METHODS.has(type),
			);
		}
	});

	it("drives session activity from the derived set", () => {
		for (const type of EVERY_TYPE)
			expect(refreshesSessionActivity(type), type).toBe(!RPC_ACTIVITY_NEUTRAL_METHODS.has(type));
	});

	it("drives handover admission from the derived set", async () => {
		const handover = new HostIdleHandover({
			identity: () => ({ instanceId: "i", generation: 1, runtimeBuildId: "old" }),
			isIdle: () => false,
			perform: async () => ({ ok: false, reason: "unused" }),
			pollMs: 60_000,
		});
		try {
			const answer = await handover.begin({
				operationId: "op",
				ifInstanceId: "i",
				ifGeneration: 1,
				targetRuntimeBuildId: "new",
				launch: { command: "c", args: [] },
				hostArgs: [],
				env: {},
			});
			expect(answer).toMatchObject({ kind: "operation", view: { state: "handover_pending" } });
			for (const type of EVERY_TYPE) expect(handover.admits(type), type).toBe(!RPC_NEW_WORK_METHODS.has(type));
		} finally {
			handover.dispose();
		}
	});
});

describe("senpi#4324 one schema for inbound validators", () => {
	it("has a validator for every inbound record type and none for anything else", () => {
		expect(Object.keys(RPC_INBOUND_SCHEMAS).sort()).toEqual([...EVERY_TYPE].sort());
		expect(Object.keys(RPC_METHOD_CLASS).sort()).toEqual([...EVERY_TYPE].sort());
	});

	it.each(EVERY_TYPE)("accepts a well-typed %s record", (type) => {
		expect(validateRpcInboundRecord(SAMPLES[type])).toEqual({ ok: true });
	});

	it("accepts an unknown additive field, as the local connection does", () => {
		expect(validateRpcInboundRecord({ type: "get_state", sessionId: "s", origin_host_instance: "h" })).toEqual({
			ok: true,
		});
	});

	it.each([
		["a non-object", "prompt", "RPC command must be a JSON object."],
		["an array", [{ type: "prompt" }], "RPC command must be a JSON object."],
		["a missing type", {}, "type must be a string."],
		["an unknown type", { type: "zz_unknown" }, 'unknown record type: "zz_unknown".'],
		["a prototype key", { type: "constructor" }, 'unknown record type: "constructor".'],
	])("refuses %s", (_label, record, reason) => {
		expect(validateRpcInboundRecord(record)).toEqual({ ok: false, reason });
	});

	it("bounds the type it echoes", () => {
		const result = validateRpcInboundRecord({ type: "a".repeat(10_000) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.length).toBeLessThan(120);
	});

	it.each([
		["a missing required field", { type: "prompt" }],
		["a wrong field type", { type: "set_fast_mode", enabled: "yes" }],
		["an out-of-set literal", { type: "set_thinking_level", level: "extreme" }],
		["a navigate_tree with both targets", { type: "navigate_tree", entryId: "e", targetId: "t" }],
		["a move_session with an unknown op", { type: "move_session", op: "teleport", moveId: "m" }],
		[
			"a killed bash result with a string exit code",
			{ ...SAMPLES.record_bash_result, result: { output: "", exitCode: "1", cancelled: true, truncated: false } },
		],
	])("refuses %s by its schema", (_label, record) => {
		const result = validateRpcInboundRecord(record);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("does not match its schema");
	});

	it.each([
		["an empty resolve_path", { type: "resolve_path", path: " " }],
		["an oversized prompt", { type: "prompt", message: "x".repeat(1_000_001) }],
		["an over-wide open_session context", { type: "open_session", context: { BAD: "v" } }],
		["a malformed session entry", { type: "append_session_entry", entry: { type: "message" } }],
	])("refuses %s by the host's field bounds", (_label, record) => {
		expect(validateRpcInboundRecord(record).ok).toBe(false);
	});

	it("accepts a killed bash result without an exit code", () => {
		const result = { output: "", cancelled: true, truncated: false };
		expect(validateRpcInboundRecord({ type: "record_bash_result", command: "x", result })).toEqual({ ok: true });
	});
});

describe("senpi#4324 question answer bounds for validated callers", () => {
	const answers = (count: number, selected: number, label = "a") =>
		Object.fromEntries(
			Array.from({ length: count }, (_, index) => [`q${index}`, { selected: Array(selected).fill(label) }]),
		);
	const response = (map: unknown) => ({ type: "extension_ui_response", id: "u", answers: map });
	const progress = (map: unknown) => ({ type: "extension_ui_progress", id: "u", answers: map });
	const { answers: maxAnswers, selectedPerAnswer, labelCharacters } = RPC_QUESTION_ANSWER_LIMITS;

	it.each([
		["answers at the cap", answers(maxAnswers, 1), true],
		["one answer over the cap", answers(maxAnswers + 1, 1), false],
		["selected labels at the cap", answers(1, selectedPerAnswer), true],
		["one selected label over the cap", answers(1, selectedPerAnswer + 1), false],
		["a label at the length cap", answers(1, 1, "x".repeat(labelCharacters)), true],
		["a label one character over", answers(1, 1, "x".repeat(labelCharacters + 1)), false],
	])("%s", (_label, map, ok) => {
		expect(validateRpcInboundRecord(response(map)).ok).toBe(ok);
		expect(validateRpcInboundRecord(progress(map)).ok).toBe(ok);
	});
});
