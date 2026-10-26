/**
 * One schema per inbound RPC record type, and the validator built from it (senpi#4324).
 *
 * The schemas are the single source a runtime validator is generated from. The record is exhaustive over
 * `RpcInboundRecord["type"]` and checked against the TypeScript record types at compile time: a schema must accept
 * every record its type allows (so no well-typed record is refused) and name exactly that type's fields, with the
 * same ones required. Unknown fields stay accepted, as they are on the local connection, so additive fields keep
 * working against older hosts.
 *
 * Typed fields are bounded (`RPC_INBOUND_LIMITS`): ids, paths, text and secrets by length, counts as non-negative
 * integers, lists and free-form records by size; the whole record (unknown additive fields and free-form payloads
 * included) is bounded by the host's own line limit, measured as its JSON.
 *
 * The local connection does not run this validator; it keeps parsing records as it always has. A caller that
 * forwards records on behalf of someone other than the local interactive user (a relay forwarder, a remote
 * viewer) imports `validateRpcInboundRecord` from the package root and refuses a record it does not accept.
 */

import Type, { type Static, type TLiteral, type TProperties, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { RpcInboundRecord } from "./rpc-host-command-types.ts";
import { MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import {
	MAX_RPC_MESSAGE_CHARACTERS,
	rpcCommandPayloadError,
	SESSION_CONTEXT_LIMITS,
	rpcCommandShapeError,
	rpcMessageLengthError,
	sessionContextError,
	sessionRetryFallbackError,
} from "./rpc-input-validation.ts";
import type { RpcMethodType } from "./rpc-method-class.ts";

/** Bounds on a question answer map (`extension_ui_response`, `extension_ui_progress`) from a validated caller. */
export const RPC_QUESTION_ANSWER_LIMITS = {
	answers: 64,
	selectedPerAnswer: 64,
	labelCharacters: MAX_RPC_MESSAGE_CHARACTERS,
} as const;

/**
 * Bounds every field of a validated caller's record stays inside (senpi#4346 review), so a record from someone
 * other than the local user cannot carry a megabyte id, a negative count or a fifty-thousand-key patch. The host's
 * own limits are reused where it has them; the rest are named here.
 */
export const RPC_INBOUND_LIMITS = {
	/** ids, session and effect ids, provider and model names, other identifiers */
	identifierCharacters: 512,
	/** host paths: session files, working directories, export and import paths */
	pathCharacters: 4096,
	/** free text: prompts, commands, edits, instructions (the host's own message limit) */
	textCharacters: MAX_RPC_MESSAGE_CHARACTERS,
	/** credentials (API keys) */
	secretCharacters: 16_384,
	/** lists of ids, model entries, capabilities, delivery ids */
	listItems: 1024,
	/** images in one prompt, steer or follow-up */
	images: 64,
	/** keys in a free-form record (a context patch, bash operations, fallback chains) */
	recordKeys: 256,
	/** the largest count, revision, sequence or index (JSON numbers stay exact below it) */
	count: Number.MAX_SAFE_INTEGER,
} as const;

/** Free text, bounded by the host's message limit. */
const Str = Type.String({ maxLength: RPC_INBOUND_LIMITS.textCharacters });
const Id = Type.String({ maxLength: RPC_INBOUND_LIMITS.identifierCharacters });
const PathStr = Type.String({ maxLength: RPC_INBOUND_LIMITS.pathCharacters });
const Secret = Type.String({ maxLength: RPC_INBOUND_LIMITS.secretCharacters });
/** Counts, revisions, sequences, indexes, sizes and durations: non-negative integers. */
const Num = Type.Integer({ minimum: 0, maximum: RPC_INBOUND_LIMITS.count });
const Bool = Type.Boolean();
const Opt = Type.Optional;
const Strings = Type.Array(Id, { maxItems: RPC_INBOUND_LIMITS.listItems });
const OptStr = Opt(Str);
const OptId = Opt(Id);
const OptPath = Opt(PathStr);
const OptNum = Opt(Num);
const OptBool = Opt(Bool);
const literals = <const L extends readonly [string, ...string[]]>(...values: L) =>
	Type.Union(values.map((value) => Type.Literal(value)) as unknown as { -readonly [I in keyof L]: TLiteral<L[I]> });

const ThinkingLevel = literals("off", "minimal", "low", "medium", "high", "xhigh", "max");
const SessionKind = literals("interactive", "worker");
const SessionContext = Type.Record(Id, Str, { maxProperties: SESSION_CONTEXT_LIMITS.keys });
// Image data is bounded by the record's line limit; the count of images is bounded where they are listed.
const ImageContent = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Id });
const Images = Type.Array(ImageContent, { maxItems: RPC_INBOUND_LIMITS.images });
const ModelEntry = Type.Object({
	model: Type.Unknown(),
	thinkingLevel: Opt(ThinkingLevel),
	thinkingSelection: Opt(Type.Unknown()),
	serviceTier: Opt(Type.Unknown()),
});
const RetryFallback = Type.Object({
	modelFallback: Bool,
	fallbackChains: Type.Record(Id, Type.Immutable(Strings), { maxProperties: RPC_INBOUND_LIMITS.recordKeys }),
});
const QuestionAnswers = Type.Record(
	Id,
	Type.Object({
		selected: Type.Array(Type.String({ maxLength: RPC_QUESTION_ANSWER_LIMITS.labelCharacters }), {
			maxItems: RPC_QUESTION_ANSWER_LIMITS.selectedPerAnswer,
		}),
		text: OptStr,
	}),
	{ maxProperties: RPC_QUESTION_ANSWER_LIMITS.answers },
);

/** A host-level record: `id` plus its own fields. */
const command = <const T extends string, const P extends TProperties>(type: T, properties: P) =>
	Type.Object({ id: OptId, type: Type.Literal(type), ...properties });

/** A session record: every one accepts the routing envelope's `sessionId`. */
const session = <const T extends string, const P extends TProperties>(type: T, properties: P) =>
	command(type, { sessionId: OptId, ...properties });

const steerOrFollowUp = <const T extends "steer" | "follow_up">(type: T) =>
	session(type, {
		message: Str,
		images: Opt(Images),
		enqueueOrder: OptNum,
		whenIdle: Opt(literals("queue", "start")),
		clientMessageId: OptId,
		clientTurnId: OptId,
	});

const editMessage = <const T extends "edit_assistant_message" | "edit_user_message">(type: T) =>
	session(type, { entryId: Id, text: Str, expectedLeafId: OptId, summarize: OptBool, customInstructions: OptStr });

const navigateTreeFields = {
	intent: Opt(literals("select", "resume")),
	expectedLeafId: OptId,
	summarize: OptBool,
	customInstructions: OptStr,
	replaceInstructions: OptBool,
	label: OptStr,
};

const move = <const P extends TProperties>(properties: P) => command("move_session", properties);

const uiResponseFrame = { type: Type.Literal("extension_ui_response"), id: Id, uiRequestId: OptId, answerId: OptId };

type RpcInboundRecordOf<K extends RpcMethodType> = Extract<RpcInboundRecord, { type: K }>;
type KeysOf<T> = T extends unknown ? keyof T : never;
type RequiredKeysOf<T> = T extends unknown
	? { [P in keyof T]-?: Record<never, never> extends Pick<T, P> ? never : P }[keyof T]
	: never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Agrees<R, S> = [R] extends [S]
	? Same<KeysOf<R>, KeysOf<S>> extends true
		? Same<RequiredKeysOf<R>, RequiredKeysOf<S>>
		: false
	: false;
type Disagreeing<Schemas extends { readonly [K in RpcMethodType]: TSchema }> = {
	[K in RpcMethodType]: Agrees<RpcInboundRecordOf<K>, Static<Schemas[K]>> extends true ? never : K;
}[RpcMethodType];
type AgreementProof<Schemas extends { readonly [K in RpcMethodType]: TSchema }> = [Disagreeing<Schemas>] extends [never]
	? unknown
	: { readonly schemaDisagreesWithRecordType: Disagreeing<Schemas> };

/** Fails the typecheck, naming the type, when a schema and its record type disagree. */
function agreeingSchemas<const Schemas extends { readonly [K in RpcMethodType]: TSchema }>(
	schemas: Schemas & AgreementProof<Schemas>,
): Schemas {
	return schemas;
}

export const RPC_INBOUND_SCHEMAS = agreeingSchemas({
	// host
	get_protocol_info: command("get_protocol_info", {
		auth: Opt(Type.Object({ client_nonce: Id })),
		observe: OptBool,
	}),
	open_session: command("open_session", {
		attended: Opt(Type.Literal(false)),
		spawnedBy: Opt(Type.Object({ parentSessionId: Id, rootSessionId: Id, taskId: Id })),
		expectedHostInstance: OptId,
		sessionPath: OptPath,
		cwd: OptPath,
		provider: OptId,
		modelId: OptId,
		thinkingLevel: Opt(ThinkingLevel),
		permissionPreset: OptId,
		retain_on_disconnect: OptBool,
		kind: Opt(SessionKind),
		context: Opt(SessionContext),
		auto_title: OptBool,
		durableSessionId: OptId,
		promptSurface: Opt(literals("terminal", "app", "chat")),
		browserEngine: Opt(literals("connected", "builtin", "none")),
		retryFallback: Opt(RetryFallback),
	}),
	close_session: command("close_session", { sessionId: Id }),
	move_session: Type.Union([
		move({ op: Type.Literal("prepare"), moveId: Id }),
		move({ op: Type.Literal("cancel"), moveId: Id }),
		move({ op: Type.Literal("status"), moveId: Id, sessionPath: OptPath }),
		move({
			op: Type.Literal("export"),
			sessionPath: PathStr,
			moveId: Id,
			target: Id,
			droppedUserMessages: Opt(Strings),
		}),
		move({ op: Type.Literal("import"), bundleDir: PathStr, cwd: PathStr, from: OptId }),
		move({ op: Type.Literal("finish"), sessionPath: PathStr, moveId: Id, answer: Type.Unknown() }),
		move({ op: Type.Literal("revoke"), sessionPath: PathStr, moveId: Id }),
	]),
	release_session: command("release_session", {
		sessionId: Id,
		reason: literals("takeover", "move"),
		moveId: OptId,
		target: OptId,
		interrupt: OptBool,
		force: OptBool,
	}),
	unload_session: command("unload_session", {
		sessionId: Id,
		effectId: OptId,
		interrupt: OptBool,
		clearQueue: OptBool,
		children: Opt(literals("refuse", "detach")),
		force: OptBool,
	}),
	detach_connection: command("detach_connection", {}),
	get_subscription_limits: command("get_subscription_limits", { observe: OptBool }),
	get_rpc_method_classes: command("get_rpc_method_classes", { observe: OptBool }),
	list_sessions: command("list_sessions", { include_workers: OptBool, observe: OptBool }),
	subscribe_sessions: command("subscribe_sessions", {
		sessions: Opt(Type.Union([Type.Literal("all"), Type.Object({ ids: Strings }), Type.Object({ childrenOf: Id })])),
		include_workers: OptBool,
		include_context: OptBool,
		effects: OptBool,
		dialogs: OptBool,
		mirror: Opt(Type.Union([Type.Literal("none"), Type.Literal("all"), Strings])),
		observe: OptBool,
	}),
	unsubscribe_sessions: command("unsubscribe_sessions", { subscriptionId: Id, observe: OptBool }),
	set_session_context: command("set_session_context", {
		sessionId: Id,
		patch: Type.Record(Id, Type.Union([Str, Type.Number(), Bool, Type.Null()]), {
			maxProperties: RPC_INBOUND_LIMITS.recordKeys,
		}),
	}),
	warm: command("warm", { cwd: OptPath, kind: Opt(SessionKind), context: Opt(SessionContext) }),
	attach_session: command("attach_session", { sessionId: Id, durableSessionId: Id, expectedHostInstance: OptId }),
	release_attachment: command("release_attachment", { sessionId: Id }),
	reclaim_session: command("reclaim_session", {
		sessionPath: PathStr,
		durableSessionId: Id,
		expectedHostInstance: Id,
	}),
	// answers
	extension_ui_response: Type.Union([
		Type.Object({ ...uiResponseFrame, value: Str }),
		Type.Object({ ...uiResponseFrame, confirmed: Bool }),
		Type.Object({ ...uiResponseFrame, cancelled: Type.Literal(true) }),
		Type.Object({ ...uiResponseFrame, answers: QuestionAnswers, comment: OptStr }),
	]),
	extension_ui_progress: Type.Object({
		type: Type.Literal("extension_ui_progress"),
		id: Id,
		answers: Opt(QuestionAnswers),
		comment: OptStr,
		sessionId: OptId,
	}),
	host_response: Type.Object({
		type: Type.Literal("host_response"),
		id: Id,
		sessionId: OptId,
		data: Opt(Type.Unknown()),
		error: OptStr,
	}),
	// prompting
	prompt: session("prompt", {
		message: Str,
		images: Opt(Images),
		streamingBehavior: Opt(literals("steer", "followUp")),
		thinkingLevel: Opt(ThinkingLevel),
		sessionTitlePrompt: Opt(Type.Union([Str, Type.Literal(false)])),
		expandPromptTemplates: OptBool,
		unknownCommandAsText: OptBool,
		clientMessageId: OptId,
		clientTurnId: OptId,
		toolBarrier: Opt(Type.Object({ id: Id, deadlineMs: Num })),
	}),
	release_tool_barrier: session("release_tool_barrier", { barrierId: Id }),
	send_custom_message: session("send_custom_message", {
		customType: Id,
		content: Type.Unknown(),
		display: Bool,
		details: Opt(Type.Unknown()),
		triggerTurn: OptBool,
		deliverAs: Opt(literals("steer", "followUp", "nextTurn")),
	}),
	continue_from_leaf: session("continue_from_leaf", {}),
	resume_session: session("resume_session", {
		expectedSeq: OptNum,
		mode: Opt(literals("continue", "release")),
		message: OptStr,
		effectId: OptId,
	}),
	append_user_message: session("append_user_message", { content: Type.Unknown() }),
	append_session_entry: session("append_session_entry", { entry: Type.Unknown() }),
	steer: steerOrFollowUp("steer"),
	follow_up: steerOrFollowUp("follow_up"),
	abort: session("abort", {
		effectId: OptId,
		awaitIdle: OptBool,
		clearQueue: OptBool,
		graceMs: OptNum,
		intent: Opt(literals("stop", "abort")),
	}),
	interrupt: session("interrupt", { turnId: OptId, intent: Opt(literals("stop", "abort")) }),
	hold_input: session("hold_input", {
		inputId: Id,
		revision: Num,
		text: Str,
		parentSessionId: OptId,
		origin: Opt(Type.Literal("human")),
	}),
	withdraw_held_input: session("withdraw_held_input", { inputId: Id }),
	pause_for_run: session("pause_for_run", {
		parentSessionId: Id,
		parentPauseSeq: Num,
		runRef: Type.Object({ kind: literals("dag", "task", "workpool", "team"), id: Id }),
	}),
	resume_for_run: session("resume_for_run", {
		parentSessionId: Id,
		parentPauseSeq: Num,
		resumeId: Id,
		childSeqCutoff: Num,
	}),
	abort_compaction: session("abort_compaction", {}),
	reload: session("reload", {}),
	check_reload_veto: session("check_reload_veto", {}),
	clear_queue: session("clear_queue", { abortWillFollow: OptBool }),
	dequeue_message: session("dequeue_message", { queuedId: Id, expectedRevision: OptNum, effectId: OptId }),
	edit_queued_message: session("edit_queued_message", {
		queuedId: Id,
		text: Str,
		expectedRevision: OptNum,
		effectId: OptId,
	}),
	get_steering_messages: session("get_steering_messages", {}),
	get_follow_up_messages: session("get_follow_up_messages", {}),
	abort_branch_summary: session("abort_branch_summary", {}),
	new_session: session("new_session", { parentSession: OptPath }),
	wake: session("wake", { delivery_ids: Opt(Strings) }),
	// state
	get_state: session("get_state", {}),
	get_snapshot: session("get_snapshot", { tail: OptNum, maxBytes: OptNum, observe: OptBool }),
	request_self_settle: session("request_self_settle", {}),
	get_effect_status: session("get_effect_status", { effectId: Id, sessionPath: OptPath }),
	get_pending_inputs: session("get_pending_inputs", { knownClientMessageIds: Opt(Strings) }),
	// model and thinking
	set_model: session("set_model", { provider: Id, modelId: Id, effectId: OptId }),
	set_favorite_models: session("set_favorite_models", {
		models: Type.Array(ModelEntry, { maxItems: RPC_INBOUND_LIMITS.listItems }),
	}),
	set_scoped_models: session("set_scoped_models", {
		models: Type.Array(ModelEntry, { maxItems: RPC_INBOUND_LIMITS.listItems }),
	}),
	cycle_model: session("cycle_model", { direction: Opt(literals("forward", "backward")) }),
	get_available_models: session("get_available_models", {}),
	set_thinking_level: session("set_thinking_level", {
		level: ThinkingLevel,
		scope: Opt(Type.Literal("turn")),
		effectId: OptId,
	}),
	cycle_thinking_level: session("cycle_thinking_level", {}),
	get_available_thinking_levels: session("get_available_thinking_levels", {}),
	get_model_thinking_level: session("get_model_thinking_level", { provider: Id, modelId: Id }),
	set_fast_mode: session("set_fast_mode", { enabled: Bool }),
	get_fast_mode: session("get_fast_mode", {}),
	set_steering_mode: session("set_steering_mode", { mode: literals("all", "one-at-a-time") }),
	set_follow_up_mode: session("set_follow_up_mode", { mode: literals("all", "one-at-a-time") }),
	compact: session("compact", { customInstructions: OptStr }),
	set_auto_compaction: session("set_auto_compaction", { enabled: Bool }),
	set_auto_retry: session("set_auto_retry", { enabled: Bool }),
	abort_retry: session("abort_retry", {}),
	set_retry_fallback: session("set_retry_fallback", { retryFallback: RetryFallback }),
	// bash
	bash: session("bash", {
		command: Str,
		bashId: OptId,
		excludeFromContext: OptBool,
		executionId: OptId,
		operations: Opt(Type.Record(Id, Type.Unknown(), { maxProperties: RPC_INBOUND_LIMITS.recordKeys })),
	}),
	record_bash_result: session("record_bash_result", {
		command: Str,
		// JSON has no `undefined`: a killed command's result arrives without `exitCode`.
		result: Type.Object({
			output: Str,
			exitCode: Opt(Type.Integer()),
			cancelled: Bool,
			truncated: Bool,
			fullOutputPath: OptPath,
		}),
		excludeFromContext: OptBool,
	}),
	abort_bash: session("abort_bash", {}),
	cleanup_bash_output: session("cleanup_bash_output", { path: PathStr }),
	// tree and session
	set_label: session("set_label", { entryId: Id, label: OptStr }),
	navigate_tree: Type.Union([
		session("navigate_tree", { ...navigateTreeFields, entryId: Id, targetId: Opt(Type.Never()) }),
		session("navigate_tree", { ...navigateTreeFields, targetId: Id, entryId: Opt(Type.Never()) }),
	]),
	get_session_stats: session("get_session_stats", {}),
	resolve_path: session("resolve_path", { path: PathStr }),
	memory_report: session("memory_report", {}),
	export_html: session("export_html", { outputPath: OptPath, themeName: OptId }),
	export_jsonl: session("export_jsonl", { outputPath: OptPath }),
	switch_session: session("switch_session", { sessionPath: PathStr, cwdOverride: OptPath }),
	fork: session("fork", { entryId: Id, position: Opt(literals("before", "at")) }),
	edit_assistant_message: editMessage("edit_assistant_message"),
	edit_user_message: editMessage("edit_user_message"),
	clone: session("clone", {}),
	get_fork_messages: session("get_fork_messages", {}),
	get_entries: session("get_entries", {
		since: OptId,
		before: OptId,
		limit: OptNum,
		tail: OptNum,
		maxBytes: OptNum,
	}),
	get_tree: session("get_tree", {}),
	get_last_assistant_text: session("get_last_assistant_text", {}),
	set_session_name: session("set_session_name", { name: Str }),
	record_user_activity: session("record_user_activity", { kind: Type.Literal("draft") }),
	import_jsonl: session("import_jsonl", { inputPath: PathStr, cwdOverride: OptPath }),
	get_messages: session("get_messages", {}),
	get_media: session("get_media", { toolCallId: Id, contentIndex: Num }),
	get_commands: session("get_commands", {}),
	get_loaded_surfaces: session("get_loaded_surfaces", {}),
	extension_request: session("extension_request", { name: Id, data: Opt(Type.Unknown()) }),
	"eval_cells.list": session("eval_cells.list", {}),
	"eval_cells.peek": session("eval_cells.peek", { cellId: Id, tailBytes: OptNum }),
	"eval_cells.stop": session("eval_cells.stop", { cellId: Id }),
	// credentials and accounts
	get_auth_providers: session("get_auth_providers", {}),
	login_start: session("login_start", { provider: Id }),
	login_cancel: session("login_cancel", { provider: Id }),
	login_api_key: session("login_api_key", { provider: Id, key: Secret }),
	logout: session("logout", { provider: Id }),
	verify_api_key: session("verify_api_key", { provider: Id, key: Secret }),
	get_provider_accounts: session("get_provider_accounts", { provider: Id }),
	account_pin: session("account_pin", { provider: Id, name: Type.Union([Id, Type.Null()]) }),
	account_remove: session("account_remove", { provider: Id, name: Id }),
	account_order: session("account_order", { provider: Id, names: Type.Union([Strings, Type.Null()]) }),
	set_client_info: session("set_client_info", {
		width: Type.Integer({ minimum: 1, maximum: 100_000 }),
		capabilities: Opt(Strings),
	}),
});

export type RpcInboundValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const MAX_REASON_TYPE_CHARACTERS = 64;

function refuse(reason: string): RpcInboundValidation {
	return { ok: false, reason };
}

/** Bounds the schema leaves to the existing field validators, so both paths refuse the same values. */
function fieldBoundsError(record: Record<string, unknown>): string | undefined {
	const payload = rpcCommandPayloadError(record) ?? rpcMessageLengthError(record);
	if (payload !== undefined) return payload;
	if (record.type === "open_session" || record.type === "warm") {
		const context = sessionContextError(record.context);
		if (context !== undefined) return context;
	}
	if (record.type === "open_session") return sessionRetryFallbackError(record.retryFallback);
	if (record.type === "set_retry_fallback") return sessionRetryFallbackError(record.retryFallback);
	return undefined;
}

/**
 * Whether a caller other than the local interactive user may pass `record` on: an object whose `type` has a
 * schema, that matches it, and whose fields are inside the bounds the host enforces. A refusal names the type and
 * the first failing field, never a field's value.
 */
export function validateRpcInboundRecord(record: unknown): RpcInboundValidation {
	const shape = rpcCommandShapeError(record);
	if (shape !== undefined) return refuse(shape);
	// The whole record, unknown fields and free-form payloads included, stays inside the host's line limit.
	let size: number;
	try {
		size = JSON.stringify(record).length;
	} catch {
		return refuse("the record is not JSON-serializable.");
	}
	if (size > MAX_RPC_LINE_CHARACTERS)
		return refuse(`the record is ${size} characters of JSON, at most ${MAX_RPC_LINE_CHARACTERS}.`);
	const value = record as Record<string, unknown>;
	const type = value.type;
	if (typeof type !== "string") return refuse("type must be a string.");
	if (!Object.hasOwn(RPC_INBOUND_SCHEMAS, type)) {
		const shown = type.length > MAX_REASON_TYPE_CHARACTERS ? `${type.slice(0, MAX_REASON_TYPE_CHARACTERS)}...` : type;
		return refuse(`unknown record type: ${JSON.stringify(shown)}.`);
	}
	const schema: TSchema = RPC_INBOUND_SCHEMAS[type as RpcMethodType];
	if (!Check(schema, record)) {
		const [first] = Errors(schema, record);
		const at = first?.instancePath ? ` at ${first.instancePath}` : "";
		return refuse(`${type}: does not match its schema${at}${first ? `: ${first.message}` : ""}.`);
	}
	const bounds = fieldBoundsError(value);
	return bounds === undefined ? { ok: true } : refuse(`${type}: ${bounds}`);
}
