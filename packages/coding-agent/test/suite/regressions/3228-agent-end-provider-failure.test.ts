import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { describeProviderFailure, formatProviderFailure } from "../../../src/core/provider-failure.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3228: agent_end carries a structured provider failure with a reason and an action,
// built only from the adapter's providerDiagnostic.

function failedTurn(errorMessage: string, providerDiagnostic?: ProviderDiagnostic): AssistantMessage {
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
	return providerDiagnostic === undefined ? message : { ...message, providerDiagnostic };
}

const STRUCTURED_FIELDS = new Set([
	"category",
	"provider",
	"model",
	"selectedProvider",
	"selectedModel",
	"httpStatus",
	"code",
	"reason",
	"action",
]);

/** The failure is built from structured fields only: no free-form provider text, no raw diagnostic. */
function expectStructuredOnly(failure: unknown, providerText: string): void {
	expect(Object.keys(failure as object).filter((key) => !STRUCTURED_FIELDS.has(key))).toEqual([]);
	expect(JSON.stringify(failure)).not.toContain(providerText);
}

describe("agent_end provider failure", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function agentEndOf(response: AssistantMessage): Promise<Extract<AgentSessionEvent, { type: "agent_end" }>> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([response]);
		const ended = new Promise<Extract<AgentSessionEvent, { type: "agent_end" }>>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				unsubscribe();
				resolve(event);
			});
		});
		await harness.session.prompt("go");
		return ended;
	}

	it.each([
		[{ category: "auth", httpStatus: 401, evidence: "structured_status" }, "auth", /re-authenticate/],
		[
			{ category: "rate_limit", httpStatus: 429, code: "rate_limit_error", evidence: "structured_code" },
			"rate_limit",
			/retry later/,
		],
		[
			{ category: "quota", httpStatus: 429, code: "insufficient_quota", evidence: "structured_code" },
			"quota",
			/plan or credits/,
		],
		[
			{ category: "context_limit", code: "context_length_exceeded", evidence: "structured_code" },
			"context_limit",
			/compact/,
		],
		[{ category: "network", code: "ECONNRESET", evidence: "structured_transport" }, "network", /connectivity/],
	] as const)("classifies %o as %s with its action", async (diagnostic, category, action) => {
		const end = await agentEndOf(failedTurn("provider failed", diagnostic));
		expect(end.failure).toMatchObject({ category, provider: "faux", model: "faux-1" });
		// senpi#4328: the request ran on the selected model, so no selection is reported beside it.
		expect(end.failure).not.toHaveProperty("selectedProvider");
		expect(end.failure).not.toHaveProperty("selectedModel");
		expect(end.failure?.action).toMatch(action);
		expect(end.failure?.reason.length).toBeGreaterThan(0);
	});

	it("reports an unclassified provider error as unknown with the provider and code, never from the message", async () => {
		const end = await agentEndOf(
			failedTurn("401 invalid api key: rate limit quota exceeded", {
				category: "unknown",
				httpStatus: 403,
				code: "permission_error",
				evidence: "structured_code",
			}),
		);
		expect(end.failure?.category).toBe("unknown");
		expect(end.failure?.reason).toMatch(/could not be classified \(faux, code permission_error\)/);
		expect(end.failure?.action).toMatch(/^retry once/);
		expectStructuredOnly(end.failure, "invalid api key");
	});

	it("falls back to unknown, not a guess from the message, when the error carries no diagnostic", async () => {
		const end = await agentEndOf(failedTurn("429 rate limit exceeded"));
		expect(end.failure?.category).toBe("unknown");
		expect(end.failure?.reason).toMatch(/\(faux, no code\)/);
		expectStructuredOnly(end.failure, "rate limit exceeded");
	});

	// senpi#4328: a fallback rung failing names the rung that ran and the model the user selected.
	it("names the model that failed and the selected model when a fallback rung ran the request", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-primary" }, { id: "faux-rung" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, fallbackChains: { "faux/faux-primary": ["faux/faux-rung"] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "billing error: insufficient_quota for this model",
			}),
			failedTurn("denied", { category: "auth", httpStatus: 401, evidence: "structured_status" }),
		]);

		await harness.session.prompt("go");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-primary", "faux-rung"]);
		const failures = harness.eventsOfType("agent_end").map((event) => event.failure);
		expect(failures.at(-1)).toMatchObject({
			category: "auth",
			provider: "faux",
			model: "faux-rung",
			selectedProvider: "faux",
			selectedModel: "faux-primary",
		});
	});

	it("omits failure on a successful turn", async () => {
		const end = await agentEndOf(fauxAssistantMessage("fine"));
		expect(end.failure).toBeUndefined();
	});

	it("omits failure on an aborted turn", async () => {
		const end = await agentEndOf(fauxAssistantMessage("", { stopReason: "aborted" }));
		expect(end.failure).toBeUndefined();
	});

	// senpi#4328: the TUI line names the ids of the provider and model that served the request,
	// and of the selected ones when they differ.
	it("renders one line naming the model and provider ids", () => {
		const failure = describeProviderFailure(
			{ category: "rate_limit", httpStatus: 429, code: "rate_limit_error", evidence: "structured_code" },
			"kiro",
			"claude-opus-5",
		);
		const line = formatProviderFailure(failure);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("claude-opus-5");
		expect(line).toContain("kiro");
		const rerouted = formatProviderFailure({ ...failure, selectedProvider: "anthropic", selectedModel: "opus-pick" });
		expect(rerouted).toContain("anthropic");
		expect(rerouted).toContain("opus-pick");
	});
});
