import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// A gateway that does not serve a configured model id answers 400 model_not_found. That is a
// configuration error: walking the fallback chain silently ran the turn on another provider's model.
const primary = "faux/faux-1";
const modelNotFound = '400 {"code":"model_not_found","message":"unknown provider for model faux-1"}';
const unknownProvider = "400 Bad Request: unknown provider for model faux-1";

async function chainedHarness(harnesses: Harness[]): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		settings: {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 60_000,
				fallbackChains: { [primary]: ["other-faux/faux-2"] },
			},
		},
	});
	harnesses.push(harness);
	registerFallbackModels(harness, "other-faux", ["faux-2"]);
	return harness;
}

function fallbackLogEvents(harness: Harness): readonly Record<string, unknown>[] {
	const text = readFileSync(join(harness.tempDir, "agent", "logs", "fallback.log"), "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("senpi#4282 model_not_found is a configuration error", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const [label, errorMessage] of [
		["model_not_found", modelNotFound],
		["unknown provider for model", unknownProvider],
	] as const) {
		it(`fails the turn loudly on ${label} instead of walking the fallback chain`, async () => {
			const harness = await chainedHarness(harnesses);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("fallback answer"),
			]);

			await harness.session.prompt("hello");

			expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.session.model?.provider).toBe("faux");
			expect(harness.session.state.messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage,
				errorCause: { type: "model_config", model: primary },
			});
			expect(harness.eventsOfType("model_config_error")).toEqual([
				{ type: "model_config_error", model: primary, provider: "faux", errorExcerpt: errorMessage },
			]);
			expect(fallbackLogEvents(harness).filter((entry) => entry.event === "model_config_error")).toMatchObject([
				{ level: "warn", model: primary, provider: "faux", errorMessage },
			]);
		});
	}

	it("reports the configuration error once per model and session", async () => {
		const harness = await chainedHarness(harnesses);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: modelNotFound }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: modelNotFound }),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("model_config_error")).toHaveLength(1);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			errorCause: { type: "model_config", model: primary },
		});
	});

	it("redacts credentials the provider echoed in the error body", async () => {
		const harness = await chainedHarness(harnesses);
		const echoed = `${modelNotFound} request had Authorization: Bearer sk-test-0123456789abcdef`;
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: echoed })]);

		await harness.session.prompt("hello");

		const [event] = harness.eventsOfType("model_config_error");
		expect(event?.errorExcerpt).not.toContain("sk-test-0123456789abcdef");
		expect(event?.errorExcerpt).toContain("model_not_found");
		const last = harness.session.state.messages.at(-1);
		expect(last?.role === "assistant" ? last.errorMessage : undefined).not.toContain("sk-test-0123456789abcdef");
	});
});
