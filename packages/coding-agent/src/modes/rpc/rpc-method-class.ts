/**
 * The engine's own classification of every inbound RPC record (senpi#4319).
 *
 * A client that speaks for someone other than the local user (a forwarder, a remote viewer, an automation) needs
 * to know which records it may accept from that someone. A list kept outside the engine drifts the moment a method
 * lands, so the table lives here and is exhaustive at compile time: it `satisfies` a mapped type over
 * `RpcInboundRecord["type"]`, so a record type added without a class fails the typecheck. An entry is a class, or a
 * versioned rule (a pure function of the record) when the class depends on its fields. The engine only classifies; it does not gate its
 * own local connections with this table.
 *
 * Classes, least to most dangerous:
 * - `observe`: side-effect-free reads.
 * - `drive`: runs, steers or edits the current session (prompts, queue and message edits, session-scoped settings).
 * - `answer`: replies to a question or dialog the engine asked.
 * - `thread`: creates, opens, attaches, switches, forks or closes sessions.
 * - `device_admin`: acts on the device outside the agent's own permission flow (direct shell, filesystem writes and
 *   probes, credentials, device-wide settings, extension reloads, forged session entries). A remote caller needs the
 *   explicit `admin` grant for it.
 * - `connection_local`: configures or tears down the caller's own connection or host ownership; meaningful only to
 *   the connection that sends it, so it is never permitted on someone else's behalf.
 *
 * At runtime a record the table does not classify (unknown type, non-string type, not an object) is treated as more
 * dangerous than every class: `rpcMethodPermitted` refuses it whatever is granted.
 */

import { createHash } from "node:crypto";
import type { SessionEntry, SessionMessageEntry } from "../../core/session-manager.ts";
import type { RpcInboundRecord } from "./rpc-host-command-types.ts";

export type RpcMethodClass = "observe" | "drive" | "answer" | "thread" | "device_admin" | "connection_local";

export type RpcMethodType = RpcInboundRecord["type"];

type RpcInboundRecordOf<K extends RpcMethodType> = Extract<RpcInboundRecord, { type: K }>;

/**
 * A record-dependent entry: a pure function of the record plus the version of its rule. The digest hashes the entry
 * as `type=dynamic@<version>`, so changing what `classify` decides REQUIRES bumping `version`; otherwise a client
 * holding the old digest never learns the rule moved. The outputs of each version are pinned by a fixture keyed
 * `<type>@<version>` in `test/suite/regressions/4319-rpc-method-class.test.ts`: a classify change without a version
 * bump fails that test.
 */
interface RpcMethodClassRule<K extends RpcMethodType> {
	readonly classify: (record: RpcInboundRecordOf<K>) => RpcMethodClass;
	readonly version: number;
}

/** A fixed class, or a versioned rule for a type whose class depends on its fields. */
type RpcMethodClassEntry<K extends RpcMethodType> = RpcMethodClass | RpcMethodClassRule<K>;

type RpcMethodClassTable = { readonly [K in RpcMethodType]: RpcMethodClassEntry<K> };

/** Bumped when the meaning of a class changes; a reassignment changes only the digest. */
export const RPC_METHOD_CLASSES_VERSION = 1;

/** Advertised in `get_protocol_info.capabilities`; `get_rpc_method_classes` answers the table. */
export const RPC_METHOD_CLASSES_CAPABILITY = "rpc_method_classes";

/** How `get_rpc_method_classes` names an entry whose class depends on the record. */
export const RPC_METHOD_CLASS_DYNAMIC = "dynamic";

/**
 * Which session entry types a user could author through the session's own input. Exhaustive over
 * `SessionEntry["type"]`, so a new entry type has to be placed here before it typechecks.
 */
const ENTRY_AUTHORSHIP = {
	message: "user_role_only",
	thinking_level_change: "engine",
	configuration_update: "engine",
	model_change: "engine",
	model_change_rejected: "engine",
	usage: "engine",
	compaction: "engine",
	branch_summary: "engine",
	custom: "engine",
	custom_message: "engine",
	context_edit: "engine",
	label: "engine",
	session_info: "engine",
} as const satisfies Record<SessionEntry["type"], "user_role_only" | "engine">;

const USER_ROLE = "user" satisfies SessionMessageEntry["message"]["role"];

/** A user-authored message entry drives the session; any other entry is a forged record of engine work. */
function appendEntryClass(record: object): RpcMethodClass {
	const entry: unknown = Reflect.get(record, "entry");
	if (typeof entry !== "object" || entry === null) return "device_admin";
	const entryType: unknown = Reflect.get(entry, "type");
	if (typeof entryType !== "string" || !Object.hasOwn(ENTRY_AUTHORSHIP, entryType)) return "device_admin";
	if (ENTRY_AUTHORSHIP[entryType as SessionEntry["type"]] !== "user_role_only") return "device_admin";
	const message: unknown = Reflect.get(entry, "message");
	if (typeof message !== "object" || message === null) return "device_admin";
	return Reflect.get(message, "role") === USER_ROLE ? "drive" : "device_admin";
}

export const RPC_METHOD_CLASS = {
	// observe
	get_protocol_info: "observe",
	get_rpc_method_classes: "observe",
	get_subscription_limits: "observe",
	list_sessions: "observe",
	get_state: "observe",
	get_snapshot: "observe",
	get_entries: "observe",
	get_messages: "observe",
	get_tree: "observe",
	get_fork_messages: "observe",
	get_last_assistant_text: "observe",
	get_session_stats: "observe",
	get_effect_status: "observe",
	get_pending_inputs: "observe",
	get_follow_up_messages: "observe",
	get_steering_messages: "observe",
	get_commands: "observe",
	get_loaded_surfaces: "observe",
	get_available_models: "observe",
	get_available_thinking_levels: "observe",
	get_model_thinking_level: "observe",
	get_fast_mode: "observe",
	get_media: "observe",
	memory_report: "observe",
	"eval_cells.list": "observe",
	"eval_cells.peek": "observe",
	// drive
	prompt: "drive",
	steer: "drive",
	follow_up: "drive",
	abort: "drive",
	interrupt: "drive",
	abort_retry: "drive",
	abort_compaction: "drive",
	abort_branch_summary: "drive",
	compact: "drive",
	clear_queue: "drive",
	dequeue_message: "drive",
	edit_queued_message: "drive",
	hold_input: "drive",
	withdraw_held_input: "drive",
	append_user_message: "drive",
	edit_user_message: "drive",
	edit_assistant_message: "drive",
	send_custom_message: "drive",
	continue_from_leaf: "drive",
	navigate_tree: "drive",
	set_label: "drive",
	set_session_name: "drive",
	set_model: "drive",
	cycle_model: "drive",
	set_thinking_level: "drive",
	cycle_thinking_level: "drive",
	set_fast_mode: "drive",
	set_steering_mode: "drive",
	set_follow_up_mode: "drive",
	set_auto_compaction: "drive",
	set_auto_retry: "drive",
	set_retry_fallback: "drive",
	pause_for_run: "drive",
	resume_for_run: "drive",
	wake: "drive",
	release_tool_barrier: "drive",
	request_self_settle: "drive",
	"eval_cells.stop": "drive",
	// drive for a user-authored message entry, device_admin for any other entry
	append_session_entry: { classify: appendEntryClass, version: 1 },
	// answer
	extension_ui_response: "answer",
	extension_ui_progress: "answer",
	// thread
	new_session: "thread",
	switch_session: "thread",
	resume_session: "thread",
	fork: "thread",
	clone: "thread",
	import_jsonl: "thread",
	open_session: "thread",
	close_session: "thread",
	unload_session: "thread",
	set_session_context: "thread",
	attach_session: "thread",
	// device_admin
	bash: "device_admin",
	abort_bash: "device_admin",
	record_bash_result: "device_admin",
	cleanup_bash_output: "device_admin",
	extension_request: "device_admin",
	reload: "device_admin",
	check_reload_veto: "device_admin",
	resolve_path: "device_admin",
	login_start: "device_admin",
	login_cancel: "device_admin",
	login_api_key: "device_admin",
	logout: "device_admin",
	verify_api_key: "device_admin",
	get_auth_providers: "device_admin",
	get_provider_accounts: "device_admin",
	account_order: "device_admin",
	account_pin: "device_admin",
	account_remove: "device_admin",
	set_favorite_models: "device_admin",
	set_scoped_models: "device_admin",
	// both forms write a file on the host: without `outputPath`, into the session's cwd
	export_html: "device_admin",
	export_jsonl: "device_admin",
	// connection_local
	set_client_info: "connection_local",
	// a forwarder serves session streams itself; per-connection subscription state cannot be forwarded
	subscribe_sessions: "connection_local",
	unsubscribe_sessions: "connection_local",
	record_user_activity: "connection_local",
	detach_connection: "connection_local",
	release_session: "connection_local",
	warm: "connection_local",
	host_response: "connection_local",
	release_attachment: "connection_local",
	reclaim_session: "connection_local",
	move_session: "connection_local",
} as const satisfies RpcMethodClassTable;

/**
 * What a method's class alone does not decide (senpi#4324): the facts three host lists are derived from. Exhaustive like
 * the table, so a new record type states its traits before it typechecks, and a trait is accepted only on the classes it
 * can be true of, so the class still bounds every derived list:
 * - `observing_read`: honours `observe: true`; the connection that sent it is not host activity
 *   (`host-observe-request.ts`). Only on an `observe` method or a `connection_local` subscription toggle.
 * - `read_only`: a `device_admin` read that changes nothing; like every `observe` method it leaves an idle session's
 *   activity untouched (`session-command-activity.ts`).
 * - `new_work`: starts, extends or queues model work, so a pending handover holds it back (`host-idle-handover.ts`).
 *   Never on an `observe`, `answer` or `connection_local` method.
 */
export type RpcMethodTrait = "observing_read" | "read_only" | "new_work";

type TableEntryClass<E> = E extends RpcMethodClass ? E : RpcMethodClass;

type TraitAllowedOn<C extends RpcMethodClass> =
	| (C extends "observe" | "connection_local" ? "observing_read" : never)
	| (C extends "device_admin" ? "read_only" : never)
	| (C extends "drive" | "thread" | "device_admin" ? "new_work" : never);

type RpcMethodTraitTable = {
	readonly [K in RpcMethodType]: readonly TraitAllowedOn<TableEntryClass<(typeof RPC_METHOD_CLASS)[K]>>[];
};

export const RPC_METHOD_TRAITS = {
	// observe
	get_protocol_info: ["observing_read"],
	get_rpc_method_classes: ["observing_read"],
	get_subscription_limits: ["observing_read"],
	list_sessions: ["observing_read"],
	get_state: ["observing_read"],
	get_snapshot: ["observing_read"],
	get_entries: ["observing_read"],
	get_messages: [],
	get_tree: [],
	get_fork_messages: [],
	get_last_assistant_text: [],
	get_session_stats: [],
	get_effect_status: ["observing_read"],
	get_pending_inputs: ["observing_read"],
	get_follow_up_messages: [],
	get_steering_messages: [],
	get_commands: [],
	get_loaded_surfaces: [],
	get_available_models: [],
	get_available_thinking_levels: [],
	get_model_thinking_level: [],
	get_fast_mode: [],
	get_media: [],
	memory_report: [],
	"eval_cells.list": [],
	"eval_cells.peek": [],
	// drive
	prompt: ["new_work"],
	steer: ["new_work"],
	follow_up: ["new_work"],
	abort: [],
	interrupt: [],
	abort_retry: [],
	abort_compaction: [],
	abort_branch_summary: [],
	compact: ["new_work"],
	clear_queue: [],
	dequeue_message: [],
	edit_queued_message: [],
	hold_input: [],
	withdraw_held_input: [],
	append_user_message: ["new_work"],
	edit_user_message: ["new_work"],
	edit_assistant_message: ["new_work"],
	send_custom_message: ["new_work"],
	continue_from_leaf: ["new_work"],
	navigate_tree: [],
	set_label: [],
	set_session_name: [],
	set_model: [],
	cycle_model: [],
	set_thinking_level: [],
	cycle_thinking_level: [],
	set_fast_mode: [],
	set_steering_mode: [],
	set_follow_up_mode: [],
	set_auto_compaction: [],
	set_auto_retry: [],
	set_retry_fallback: [],
	pause_for_run: [],
	resume_for_run: [],
	wake: ["new_work"],
	release_tool_barrier: [],
	request_self_settle: [],
	"eval_cells.stop": [],
	append_session_entry: [],
	// answer
	extension_ui_response: [],
	extension_ui_progress: [],
	// thread
	new_session: [],
	switch_session: [],
	resume_session: ["new_work"],
	fork: [],
	clone: [],
	import_jsonl: [],
	open_session: [],
	close_session: [],
	unload_session: [],
	set_session_context: [],
	attach_session: [],
	// device_admin
	bash: ["new_work"],
	abort_bash: [],
	record_bash_result: [],
	cleanup_bash_output: [],
	extension_request: [],
	reload: [],
	check_reload_veto: [],
	resolve_path: ["read_only"],
	login_start: [],
	login_cancel: [],
	login_api_key: [],
	logout: [],
	verify_api_key: [],
	get_auth_providers: ["read_only"],
	get_provider_accounts: ["read_only"],
	account_order: [],
	account_pin: [],
	account_remove: [],
	set_favorite_models: [],
	set_scoped_models: [],
	export_html: [],
	export_jsonl: [],
	// connection_local
	set_client_info: [],
	subscribe_sessions: ["observing_read"],
	unsubscribe_sessions: ["observing_read"],
	record_user_activity: [],
	detach_connection: [],
	release_session: [],
	warm: [],
	host_response: [],
	release_attachment: [],
	reclaim_session: [],
	move_session: [],
} as const satisfies RpcMethodTraitTable;

type DerivedClass = RpcMethodClass | typeof RPC_METHOD_CLASS_DYNAMIC;

function methodsWhere(
	rule: (methodClass: DerivedClass, traits: readonly RpcMethodTrait[]) => boolean,
): ReadonlySet<RpcMethodType> {
	const methods = new Set<RpcMethodType>();
	for (const type of Object.keys(RPC_METHOD_CLASS) as RpcMethodType[]) {
		const entry: RpcMethodClass | object = RPC_METHOD_CLASS[type];
		const methodClass = typeof entry === "string" ? entry : RPC_METHOD_CLASS_DYNAMIC;
		if (rule(methodClass, RPC_METHOD_TRAITS[type])) methods.add(type);
	}
	return methods;
}

/** Methods whose `observe: true` keeps their connection from counting as host activity. */
export const RPC_OBSERVING_METHODS = methodsWhere(
	(methodClass, traits) =>
		(methodClass === "observe" || methodClass === "connection_local") && traits.includes("observing_read"),
);

/** Methods that leave an idle session's activity untouched: every `observe` method and the `read_only` device reads. */
export const RPC_ACTIVITY_NEUTRAL_METHODS = methodsWhere(
	(methodClass, traits) =>
		methodClass === "observe" || (methodClass === "device_admin" && traits.includes("read_only")),
);

/** Methods a pending handover holds back: they start, extend or queue model work. */
export const RPC_NEW_WORK_METHODS = methodsWhere(
	(methodClass, traits) =>
		methodClass !== "observe" &&
		methodClass !== "answer" &&
		methodClass !== "connection_local" &&
		traits.includes("new_work"),
);

/**
 * The class of an inbound record, or `undefined` when the engine cannot classify it: not a plain object, a
 * non-string `type`, or a type the table does not own (own keys only, never the prototype's).
 */
export function classifyRpcMethod(record: unknown): RpcMethodClass | undefined {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
	const type: unknown = Reflect.get(record, "type");
	if (typeof type !== "string" || !Object.hasOwn(RPC_METHOD_CLASS, type)) return undefined;
	const entry: RpcMethodClass | { readonly classify: (record: object) => RpcMethodClass } =
		RPC_METHOD_CLASS[type as RpcMethodType];
	return typeof entry === "string" ? entry : entry.classify(record);
}

/**
 * Whether a caller holding `granted` may send `record`. Fails closed: an unclassified record is refused whatever is
 * granted, `connection_local` is never permitted, and every other class only when it is granted explicitly.
 */
export function rpcMethodPermitted(record: unknown, granted: ReadonlySet<RpcMethodClass>): boolean {
	const methodClass = classifyRpcMethod(record);
	return methodClass !== undefined && methodClass !== "connection_local" && granted.has(methodClass);
}

export type RpcMethodClassDescription = RpcMethodClass | typeof RPC_METHOD_CLASS_DYNAMIC;

export type RpcMethodClassesTable = Readonly<Record<RpcMethodType, RpcMethodClassDescription>>;

/** The version of every record-dependent entry, keyed by type. */
export type RpcMethodClassDynamicVersions = Readonly<Partial<Record<RpcMethodType, number>>>;

function describeTable(): { classes: RpcMethodClassesTable; dynamicVersions: RpcMethodClassDynamicVersions } {
	const classes: Record<string, RpcMethodClassDescription> = {};
	const dynamicVersions: Record<string, number> = {};
	for (const [type, entry] of Object.entries(RPC_METHOD_CLASS)) {
		if (typeof entry === "string") {
			classes[type] = entry;
		} else {
			classes[type] = RPC_METHOD_CLASS_DYNAMIC;
			dynamicVersions[type] = entry.version;
		}
	}
	return { classes: classes as RpcMethodClassesTable, dynamicVersions };
}

/**
 * sha256 (hex) of the sorted `type=value\n` lines, where `value` is the class, or `dynamic@<version>` for a
 * record-dependent entry.
 */
export function rpcMethodClassesDigest(table: Readonly<Record<string, string>>): string {
	const lines = Object.entries(table)
		.map(([type, methodClass]) => `${type}=${methodClass}\n`)
		.sort();
	return createHash("sha256").update(lines.join("")).digest("hex");
}

const DESCRIBED_TABLE = describeTable();

function digestValues(): Record<string, string> {
	const values: Record<string, string> = { ...DESCRIBED_TABLE.classes };
	for (const [type, version] of Object.entries(DESCRIBED_TABLE.dynamicVersions))
		values[type] = `${RPC_METHOD_CLASS_DYNAMIC}@${version}`;
	return values;
}

export const RPC_METHOD_CLASSES_DIGEST = rpcMethodClassesDigest(digestValues());

/** The `rpc_method_classes` field of `get_protocol_info`: enough for a client to tell whether its copy is current. */
export interface RpcMethodClassesAdvertisement {
	readonly version: typeof RPC_METHOD_CLASSES_VERSION;
	readonly digest: string;
}

export const RPC_METHOD_CLASSES_ADVERTISEMENT: RpcMethodClassesAdvertisement = {
	version: RPC_METHOD_CLASSES_VERSION,
	digest: RPC_METHOD_CLASSES_DIGEST,
};

/** The `get_rpc_method_classes` answer: the advertisement, the table, and the version of each `dynamic` entry. */
export interface RpcMethodClassesAnswer extends RpcMethodClassesAdvertisement {
	readonly classes: RpcMethodClassesTable;
	readonly dynamic_versions: RpcMethodClassDynamicVersions;
}

export function rpcMethodClassesAnswer(): RpcMethodClassesAnswer {
	return {
		...RPC_METHOD_CLASSES_ADVERTISEMENT,
		classes: DESCRIBED_TABLE.classes,
		dynamic_versions: DESCRIBED_TABLE.dynamicVersions,
	};
}
