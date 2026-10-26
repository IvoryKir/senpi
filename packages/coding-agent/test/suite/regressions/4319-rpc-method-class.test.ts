/**
 * senpi#4319: the engine classifies every inbound RPC record, the table is exhaustive at compile time, the runtime
 * lookup fails closed, field-dependent entries resolve from the record, and the host advertises the table's digest
 * and answers the table itself.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isObservingRequest } from "../../../src/modes/rpc/host-observe-request.ts";
import type { RpcInboundRecord } from "../../../src/modes/rpc/rpc-host-command-types.ts";
import {
	classifyRpcMethod,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	type RpcMethodClass,
	rpcMethodClassesAnswer,
	rpcMethodClassesDigest,
	rpcMethodPermitted,
} from "../../../src/modes/rpc/rpc-method-class.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

type WidenedMethodType = RpcInboundRecord["type"] | "zz_unclassified_probe";
// @ts-expect-error -- exhaustiveness proof: the table has no entry for the widened literal, so it does not cover the widened union.
const widenedTable: { readonly [K in WidenedMethodType]: unknown } = RPC_METHOD_CLASS;

const EVERY_CLASS: ReadonlySet<RpcMethodClass> = new Set<RpcMethodClass>([
	"observe",
	"drive",
	"answer",
	"thread",
	"device_admin",
	"connection_local",
]);

const UNCLASSIFIED: ReadonlyArray<readonly [string, unknown]> = [
	["a synthetic unknown method", { type: "zz_unclassified_probe" }],
	["__proto__", JSON.parse('{"type":"__proto__"}')],
	["constructor", { type: "constructor" }],
	["toString", { type: "toString" }],
	["hasOwnProperty", { type: "hasOwnProperty" }],
	["a non-string type", { type: 7 }],
	["a missing type", {}],
	["a 10 KB type", { type: "a".repeat(10 * 1024) }],
	["a bare string record", "prompt"],
	["a number record", 7],
	["a null record", null],
	["an undefined record", undefined],
	["an array record", [{ type: "prompt" }]],
];

const USER_MESSAGE_ENTRY = {
	type: "message",
	id: "e1",
	parentId: null,
	timestamp: "2026-10-26T00:00:00.000Z",
	message: { role: "user", content: "hi", timestamp: 0 },
};

function typesOf(methodClass: RpcMethodClass): string[] {
	return Object.entries(RPC_METHOD_CLASS)
		.filter(([, value]) => value === methodClass)
		.map(([type]) => type);
}

function routerFor() {
	const registry = { list: () => [] } as never;
	return new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
}

describe("RPC method classes (senpi#4319)", () => {
	it("classifies every inbound record type at compile time", () => {
		expect(widenedTable).toBe(RPC_METHOD_CLASS);
		expect(classifyRpcMethod({ type: "prompt", message: "x" })).toBe("drive");
		expect(classifyRpcMethod({ type: "get_state" })).toBe("observe");
		expect(classifyRpcMethod({ type: "extension_ui_response", id: "q", cancelled: true })).toBe("answer");
		expect(classifyRpcMethod({ type: "open_session" })).toBe("thread");
		expect(classifyRpcMethod({ type: "bash", command: "true" })).toBe("device_admin");
		expect(classifyRpcMethod({ type: "set_client_info" })).toBe("connection_local");
	});

	it.each(UNCLASSIFIED)("refuses %s as unclassified even with every class granted", (_name, record) => {
		expect(classifyRpcMethod(record)).toBeUndefined();
		expect(rpcMethodPermitted(record, EVERY_CLASS)).toBe(false);
	});

	it("never permits a connection_local record, whatever is granted", () => {
		const local = typesOf("connection_local");
		expect(local).toContain("detach_connection");
		for (const type of local) expect(rpcMethodPermitted({ type }, EVERY_CLASS)).toBe(false);
	});

	it("permits device_admin only when it is granted explicitly", () => {
		const admin = typesOf("device_admin");
		expect(admin).toContain("bash");
		const allButAdmin = new Set([...EVERY_CLASS].filter((methodClass) => methodClass !== "device_admin"));
		for (const type of admin) {
			expect(rpcMethodPermitted({ type }, allButAdmin)).toBe(false);
			expect(rpcMethodPermitted({ type }, new Set<RpcMethodClass>(["device_admin"]))).toBe(true);
		}
	});

	it("permits a class only when it is granted", () => {
		expect(rpcMethodPermitted({ type: "get_state" }, new Set<RpcMethodClass>(["observe"]))).toBe(true);
		expect(rpcMethodPermitted({ type: "prompt" }, new Set<RpcMethodClass>(["observe"]))).toBe(false);
		expect(rpcMethodPermitted({ type: "prompt" }, new Set<RpcMethodClass>(["drive"]))).toBe(true);
		expect(rpcMethodPermitted({ type: "get_state" }, new Set<RpcMethodClass>())).toBe(false);
	});

	// Both forms write a file on the host: an absent outputPath writes into the session's cwd.
	it.each(["export_html", "export_jsonl"])("classifies %s as device_admin with or without outputPath", (type) => {
		expect(classifyRpcMethod({ type })).toBe("device_admin");
		expect(classifyRpcMethod({ type, outputPath: "/tmp/out" })).toBe("device_admin");
		const observeOnly = new Set<RpcMethodClass>(["observe"]);
		expect(rpcMethodPermitted({ type }, observeOnly)).toBe(false);
		expect(rpcMethodClassesAnswer().classes[type as "export_html"]).toBe("device_admin");
	});

	// A forwarder serves session streams itself; per-connection subscription state cannot be forwarded.
	it.each(["subscribe_sessions", "unsubscribe_sessions"])("classifies %s as connection_local", (type) => {
		expect(classifyRpcMethod({ type })).toBe("connection_local");
		expect(rpcMethodPermitted({ type }, EVERY_CLASS)).toBe(false);
	});

	it("drives a user-authored append_session_entry and treats any other entry as device_admin", () => {
		expect(classifyRpcMethod({ type: "append_session_entry", entry: USER_MESSAGE_ENTRY })).toBe("drive");
		const forgedToolResult = {
			...USER_MESSAGE_ENTRY,
			message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 0 },
		};
		expect(classifyRpcMethod({ type: "append_session_entry", entry: forgedToolResult })).toBe("device_admin");
		const driveOnly = new Set<RpcMethodClass>(["drive"]);
		expect(rpcMethodPermitted({ type: "append_session_entry", entry: forgedToolResult }, driveOnly)).toBe(false);
		expect(rpcMethodPermitted({ type: "append_session_entry", entry: USER_MESSAGE_ENTRY }, driveOnly)).toBe(true);
		const assistant = { ...USER_MESSAGE_ENTRY, message: { role: "assistant", content: [] } };
		expect(classifyRpcMethod({ type: "append_session_entry", entry: assistant })).toBe("device_admin");
		const label = { type: "label", id: "e2", parentId: "e1", timestamp: "t", targetId: "e1", label: "x" };
		expect(classifyRpcMethod({ type: "append_session_entry", entry: label })).toBe("device_admin");
		expect(classifyRpcMethod({ type: "append_session_entry", entry: { type: "__proto__" } })).toBe("device_admin");
		expect(classifyRpcMethod({ type: "append_session_entry", entry: "message" })).toBe("device_admin");
		expect(classifyRpcMethod({ type: "append_session_entry" })).toBe("device_admin");
	});

	// Each dynamic rule's OUTPUTS, pinned with its version: a classify change without a version bump fails here, and a
	// bump fails the key match until the fixture is re-recorded under the new version on purpose.
	it("pins every dynamic rule's outputs under <type>@<version>, so classify cannot change without a version bump", () => {
		const entry = (fields: Record<string, unknown>) => ({ id: "e", parentId: null, timestamp: "t", ...fields });
		const message = (fields: Record<string, unknown>) =>
			entry({ type: "message", message: { timestamp: 0, ...fields } });
		const appendCases: ReadonlyArray<readonly [string, unknown, RpcMethodClass]> = [
			["user message", message({ role: "user", content: "hi" }), "drive"],
			["assistant message", message({ role: "assistant", content: [] }), "device_admin"],
			[
				"tool result",
				message({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [] }),
				"device_admin",
			],
			["message without a role", message({ content: "hi" }), "device_admin"],
			["message without a message", entry({ type: "message" }), "device_admin"],
			["custom entry", entry({ type: "custom", customType: "x", data: {} }), "device_admin"],
			[
				"custom message",
				entry({ type: "custom_message", customType: "x", content: "hi", display: true }),
				"device_admin",
			],
			["label", entry({ type: "label", targetId: "e", label: "x" }), "device_admin"],
			[
				"compaction",
				entry({ type: "compaction", summary: "s", firstKeptEntryId: "e", tokensBefore: 1 }),
				"device_admin",
			],
			["model change", entry({ type: "model_change", provider: "p", modelId: "m" }), "device_admin"],
			["unknown entry type", entry({ type: "zz_unknown" }), "device_admin"],
			["entry not an object", "message", "device_admin"],
			["no entry", undefined, "device_admin"],
		];
		const fixtures: Record<string, ReadonlyArray<readonly [string, Record<string, unknown>, RpcMethodClass]>> = {
			"append_session_entry@1": appendCases.map(([name, value, expected]) => [name, { entry: value }, expected]),
			"open_session@1": [
				["by id only", { sessionId: "s" }, "thread"],
				["expected host instance", { expectedHostInstance: "h" }, "thread"],
				["provider and model", { provider: "p", modelId: "m" }, "thread"],
				["session file", { sessionPath: "/x/s.jsonl" }, "device_admin"],
				["cwd", { cwd: "/x" }, "device_admin"],
				["permission preset", { permissionPreset: "full-access" }, "device_admin"],
				["browser engine", { browserEngine: "connected" }, "device_admin"],
				["a null path still names one", { sessionPath: null }, "device_admin"],
				["an explicitly undefined field is absent", { cwd: undefined }, "thread"],
			],
			"get_effect_status@1": [
				["by session id", { sessionId: "s", effectId: "e" }, "observe"],
				["in a named session file", { sessionPath: "/x/s.jsonl", effectId: "e" }, "device_admin"],
			],
			"set_thinking_level@1": [
				["this turn only", { level: "high", scope: "turn" }, "drive"],
				["remembered for the model", { level: "high" }, "device_admin"],
				["another scope", { level: "high", scope: "session" }, "device_admin"],
			],
			"new_session@1": [
				["plain", {}, "thread"],
				["parent session file", { parentSession: "/x/p.jsonl" }, "device_admin"],
			],
		};
		const rules = Object.entries(RPC_METHOD_CLASS).flatMap(([type, value]) =>
			typeof value === "string" ? [] : [`${type}@${value.version}`],
		);
		expect(Object.keys(fixtures).sort()).toEqual(rules.sort());
		for (const [key, cases] of Object.entries(fixtures)) {
			const type = key.slice(0, key.indexOf("@"));
			const outputs = cases.map(([name, fields]) => [name, classifyRpcMethod({ type, ...fields })]);
			expect(outputs).toEqual(cases.map(([name, , expected]) => [name, expected]));
		}
	});

	// senpi#4325 review: records that name a host path or write device-wide settings are device_admin.
	it("classes host-path and global-settings records as device_admin", () => {
		for (const record of [
			{ type: "switch_session", sessionPath: "/x/s.jsonl" },
			{ type: "import_jsonl", inputPath: "/etc/hosts" },
			{ type: "set_steering_mode", mode: "all" },
			{ type: "set_follow_up_mode", mode: "all" },
			{ type: "set_auto_retry", enabled: true },
			{ type: "set_model", provider: "p", modelId: "m" },
			{ type: "cycle_model" },
			{ type: "cycle_thinking_level" },
			{ type: "set_thinking_level", level: "high" },
			{ type: "set_fast_mode", enabled: true },
		])
			expect([record.type, classifyRpcMethod(record)]).toEqual([record.type, "device_admin"]);
		expect(classifyRpcMethod({ type: "set_auto_compaction", enabled: true })).toBe("drive");
		const threadOnly = new Set<RpcMethodClass>(["thread", "drive"]);
		expect(rpcMethodPermitted({ type: "open_session", permissionPreset: "full-access" }, threadOnly)).toBe(false);
		expect(rpcMethodPermitted({ type: "open_session", sessionId: "s" }, threadOnly)).toBe(true);
	});

	it("refuses a record whose rule throws instead of crashing", () => {
		const hostile = new Proxy(
			{ type: "open_session" },
			{
				get: (target, key) => {
					if (key === "type") return target.type;
					throw new Error("hostile getter");
				},
				has: () => true,
				getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: 1 }),
			},
		);
		expect(classifyRpcMethod(hostile)).toBeUndefined();
		expect(rpcMethodPermitted(hostile, new Set<RpcMethodClass>(["thread", "device_admin"]))).toBe(false);
	});

	// A changed rule must bump its version deliberately: this snapshot makes the change visible.
	it("versions every record-dependent entry", () => {
		const { classes, dynamic_versions } = rpcMethodClassesAnswer();
		expect(dynamic_versions).toEqual({
			append_session_entry: 1,
			get_effect_status: 1,
			new_session: 1,
			open_session: 1,
			set_thinking_level: 1,
		});
		expect(
			Object.keys(classes)
				.filter((type) => classes[type as "prompt"] === "dynamic")
				.sort(),
		).toEqual(["append_session_entry", "get_effect_status", "new_session", "open_session", "set_thinking_level"]);
	});

	it("digests the sorted type=class lines, dynamic entries as type=dynamic@<version>, and changes with one reassignment", () => {
		const { classes, dynamic_versions } = rpcMethodClassesAnswer();
		expect(classes.append_session_entry).toBe("dynamic");
		expect(classes.prompt).toBe("drive");
		const digestValues: Record<string, string> = { ...classes };
		for (const [type, version] of Object.entries(dynamic_versions)) digestValues[type] = `dynamic@${version}`;
		const lines = Object.entries(digestValues)
			.map(([type, methodClass]) => `${type}=${methodClass}\n`)
			.sort()
			.join("");
		expect(lines).toContain("append_session_entry=dynamic@1\n");
		expect(RPC_METHOD_CLASSES_DIGEST).toBe(createHash("sha256").update(lines).digest("hex"));
		const reversed = Object.fromEntries(Object.entries(digestValues).reverse());
		expect(rpcMethodClassesDigest(reversed)).toBe(RPC_METHOD_CLASSES_DIGEST);
		expect(rpcMethodClassesDigest({ ...digestValues, get_state: "drive" })).not.toBe(RPC_METHOD_CLASSES_DIGEST);
		expect(rpcMethodClassesDigest({ ...digestValues, append_session_entry: "dynamic@2" })).not.toBe(
			RPC_METHOD_CLASSES_DIGEST,
		);
	});

	it("advertises the digest in get_protocol_info and answers the table on get_rpc_method_classes", async () => {
		const router = routerFor();
		const info = await router.handle({ id: "info", type: "get_protocol_info" });
		expect(info).toMatchObject({
			success: true,
			data: { rpc_method_classes: { version: 1, digest: RPC_METHOD_CLASSES_DIGEST } },
		});
		expect(info).toMatchObject({ data: { capabilities: expect.arrayContaining(["rpc_method_classes"]) } });
		expect(await router.handle({ id: "classes", type: "get_rpc_method_classes" })).toEqual({
			id: "classes",
			type: "response",
			command: "get_rpc_method_classes",
			success: true,
			data: rpcMethodClassesAnswer(),
		});
		expect(rpcMethodClassesAnswer()).toMatchObject({ version: 1, digest: RPC_METHOD_CLASSES_DIGEST });
	});

	it("serves get_rpc_method_classes as an observing read", () => {
		expect(RPC_METHOD_CLASS.get_rpc_method_classes).toBe("observe");
		expect(isObservingRequest(JSON.stringify({ type: "get_rpc_method_classes", observe: true }))).toBe(true);
	});
});
