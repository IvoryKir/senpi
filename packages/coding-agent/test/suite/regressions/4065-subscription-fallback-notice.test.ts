import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { _resetLongContextForTesting } from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { LONG_CONTEXT_FALLBACK_DIAGNOSTIC } from "../../../src/core/provider-notices.ts";
import { ContinuityNoticeTracker } from "../../../src/modes/interactive/components/continuity-notice.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

let directory: string;
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-4065-notice-"));
	_resetLongContextForTesting(join(directory, "long-context.json"));
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => directory,
	});
});
afterEach(() => {
	resetAuthLaneBoundary();
	resetSdkBoundary();
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

async function fallbackTurn(content = "hi") {
	const attempts: Options[] = [];
	const query: SdkQuery = ({ options }) => {
		if (!options) throw new Error("Expected SDK options");
		attempts.push(options);
		const first = attempts.length === 1;
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield (
					first
						? {
								type: "result",
								subtype: "error_during_execution",
								is_error: true,
								errors: [
									"API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
								],
							}
						: { type: "result", subtype: "success", result: "ok" }
				) as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
	overrideSdkBoundary({ query });
	const model = getModels("anthropic").find((candidate) => candidate.id === "claude-opus-4-6") as Model<Api>;
	const message = await streamAnthropicSubscription(
		model,
		{ messages: [{ role: "user", content, timestamp: 1 }] },
		{ cwd: directory },
	).result();
	return { message, attempts };
}

it("delivers a renderable fallback diagnostic to an attached RPC client", async () => {
	const { message } = await fallbackTurn();
	expect(message.stopReason).toBe("stop");
	const lines: string[] = [];
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("client", {
		writeRaw: (line) => {
			lines.push(line);
		},
		waitForBackpressure: async () => {},
	});
	try {
		writer.attachConnectionToSession("client", "session");
		writer.enqueue("session", { type: "message_end", message });
		await writer.flush();
		const record = JSON.parse(lines.join("")) as { type: string; message: AssistantMessage };
		expect(record.type).toBe("message_end");
		const notice = record.message.diagnostics?.find(
			(diagnostic) => diagnostic.type === LONG_CONTEXT_FALLBACK_DIAGNOSTIC,
		);
		expect(notice?.details?.contextWindow).toBe(200_000);
		expect(notice?.details?.message).toEqual(expect.any(String));
		expect(String(notice?.details?.message).length).toBeGreaterThan(0);
	} finally {
		writer.unregisterConnection("client");
	}
});

it("renders both resume and window fallback notices from one message", async () => {
	const { message } = await fallbackTurn();
	const combined = new ContinuityNoticeTracker().noticeFor({
		...message,
		diagnostics: [{ type: "claude_sdk_oauth_resume_fallback", timestamp: 1 }, ...(message.diagnostics ?? [])],
	});
	expect(combined?.split("\n")).toHaveLength(2);
});

it("does not dispatch a 200k retry for an oversized real stream request", async () => {
	const { message, attempts } = await fallbackTurn("word ".repeat(200_001));
	expect(attempts).toHaveLength(1);
	expect(message.stopReason).toBe("error");
	expect(message.errorMessage).toContain("You're out of extra usage");
	expect(message.errorMessage).toMatch(/top up/i);
	expect(message.errorMessage).toMatch(/new session|compact/i);
	expect(message.diagnostics?.some((diagnostic) => diagnostic.type === LONG_CONTEXT_FALLBACK_DIAGNOSTIC)).not.toBe(
		true,
	);
});
