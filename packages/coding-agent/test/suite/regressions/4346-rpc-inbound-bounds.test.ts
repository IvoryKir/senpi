/**
 * senpi#4346 review: the inbound validator is reachable from the package root and bounds every field a caller other
 * than the local user can send.
 */
import { RPC_INBOUND_LIMITS, validateRpcInboundRecord } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";

const refused = (record: unknown) => {
	const result = validateRpcInboundRecord(record);
	if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(record).slice(0, 80)}`);
	return result.reason;
};
const image = { type: "image", data: "AAAA", mimeType: "image/png" };
const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));

describe("inbound record bounds (senpi#4346)", () => {
	it("refuses each bound class past its limit, naming the field", () => {
		const id = "s".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1);
		expect(refused({ type: "get_state", sessionId: id })).toContain("/sessionId");
		expect(refused({ type: "bash", command: "x".repeat(RPC_INBOUND_LIMITS.textCharacters + 1) })).toContain(
			"/command",
		);
		expect(
			refused({ type: "switch_session", sessionPath: "/".repeat(RPC_INBOUND_LIMITS.pathCharacters + 1) }),
		).toContain("/sessionPath");
		expect(
			refused({ type: "login_api_key", provider: "p", key: "k".repeat(RPC_INBOUND_LIMITS.secretCharacters + 1) }),
		).toContain("/key");
		expect(refused({ type: "get_entries", limit: -5 })).toContain("/limit");
		expect(refused({ type: "get_media", toolCallId: "t", contentIndex: 1.5 })).toContain("/contentIndex");
		expect(refused({ type: "set_client_info", width: -1e308 })).toContain("/width");
		expect(
			refused({ type: "set_session_context", sessionId: "s", patch: keys(RPC_INBOUND_LIMITS.recordKeys + 1) }),
		).toContain("/patch");
		expect(
			refused({
				type: "prompt",
				message: "hi",
				images: Array.from({ length: RPC_INBOUND_LIMITS.images + 1 }, () => image),
			}),
		).toContain("/images");
		expect(
			refused({ type: "wake", delivery_ids: Array.from({ length: RPC_INBOUND_LIMITS.listItems + 1 }, () => "d") }),
		).toContain("/delivery_ids");
	});

	it("bounds the whole record, so unknown fields and free-form payloads cannot slip past", () => {
		const huge = "x".repeat(16 * 1024 * 1024);
		expect(refused({ type: "get_state", junk: huge })).toContain("characters of JSON");
		expect(refused({ type: "prompt", message: "hi", images: [{ ...image, data: huge }] })).toContain(
			"characters of JSON",
		);
		expect(refused({ type: "host_response", id: "h", data: { blob: huge } })).toContain("characters of JSON");
		expect(
			refused({ type: "account_pin", provider: "p", name: "n".repeat(RPC_INBOUND_LIMITS.identifierCharacters + 1) }),
		).toContain("/name");
		expect(validateRpcInboundRecord({ type: "get_state", note: "an additive field" })).toEqual({ ok: true });
		expect(validateRpcInboundRecord({ type: "account_pin", provider: "p", name: null })).toEqual({ ok: true });
	});

	it("accepts every bound class at its limit", () => {
		for (const record of [
			{ type: "get_state", sessionId: "s".repeat(RPC_INBOUND_LIMITS.identifierCharacters) },
			{ type: "switch_session", sessionPath: "/".repeat(RPC_INBOUND_LIMITS.pathCharacters) },
			{ type: "get_entries", limit: 0, tail: RPC_INBOUND_LIMITS.count },
			{ type: "get_media", toolCallId: "t", contentIndex: 0 },
			{ type: "set_client_info", width: 1 },
			{ type: "set_session_context", sessionId: "s", patch: keys(RPC_INBOUND_LIMITS.recordKeys) },
			{ type: "prompt", message: "hi", images: Array.from({ length: RPC_INBOUND_LIMITS.images }, () => image) },
			{
				type: "record_bash_result",
				command: "x",
				result: { output: "", exitCode: -9, cancelled: false, truncated: false },
			},
		])
			expect([record.type, validateRpcInboundRecord(record)]).toEqual([record.type, { ok: true }]);
	});
});
