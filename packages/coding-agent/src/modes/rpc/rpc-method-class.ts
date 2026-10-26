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
 * holding the old digest never learns the rule moved.
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
