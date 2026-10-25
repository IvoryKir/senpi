import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";
import { MODEL_NOT_FOUND_ANSWERS, NOT_MODEL_NOT_FOUND_ANSWERS } from "../model-not-found-inventory.ts";
import { isModelConfigError } from "../../../src/core/retry-fallback/model-config-error.ts";
import { READABLE_PROVIDER_TEXT, SECRET_CELLS } from "../secret-inventory.ts";

// A gateway that does not serve a configured model id answers model_not_found. That is a configuration
// error: walking the fallback chain silently ran the turn on another provider's model.
const primary = "faux/faux-1";
const modelNotFound = '400 {"code":"model_not_found","message":"unknown provider for model faux-1"}';

async function chainedHarness(harnesses: Harness[], options: { persistSession?: boolean } = {}): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		persistSession: options.persistSession,
		settings: {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1,
				fallbackChains: { [primary]: ["other-faux/faux-2", "third-faux/faux-3"] },
			},
		},
	});
	harnesses.push(harness);
	registerFallbackModels(harness, "other-faux", ["faux-2"]);
	registerFallbackModels(harness, "third-faux", ["faux-3"]);
	return harness;
}

function fallbackLogText(harness: Harness): string {
	return readFileSync(join(harness.tempDir, "agent", "logs", "fallback.log"), "utf8");
}

function fallbackLogEvents(harness: Harness): readonly Record<string, unknown>[] {
	return fallbackLogText(harness)
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function persistedSessionText(harness: Harness): string {
	const dir = join(harness.tempDir, "sessions");
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((name) => join(dir, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}

function lastErrorMessage(harness: Harness): string | undefined {
	const last = harness.session.state.messages.at(-1);
	return last?.role === "assistant" ? last.errorMessage : undefined;
}

describe("senpi#4282 model_not_found is a configuration error", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	describe("classifies the shared model-not-found inventory", () => {
		for (const [label, message] of MODEL_NOT_FOUND_ANSWERS) {
			it(`${label} is a configuration error`, () => {
				expect(isModelConfigError(message)).toBe(true);
			});
		}
		for (const [label, message] of NOT_MODEL_NOT_FOUND_ANSWERS) {
			it(`${label} is not a configuration error`, () => {
				expect(isModelConfigError(message)).toBe(false);
			});
		}
	});

	for (const [label, errorMessage] of MODEL_NOT_FOUND_ANSWERS) {
		it(`fails the turn loudly on ${label} with no retry and no fallback`, async () => {
			const harness = await chainedHarness(harnesses);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("retry answer"),
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

	it("ends the turn on a fallback model that is not served instead of trying the next rung", async () => {
		const harness = await chainedHarness(harnesses);
		const notServed = '400 {"code":"model_not_found","message":"unknown provider for model faux-2"}';
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "billing error: insufficient_quota" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: notServed }),
			fauxAssistantMessage("third rung answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(["other-faux/faux-2"]);
		expect(harness.eventsOfType("model_config_error").map((event) => event.model.split("/").at(-1))).toEqual([
			"faux-2",
		]);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			model: "faux-2",
			errorCause: { type: "model_config" },
		});
	});

	describe("redacts every secret shape in every container from every sink", () => {
		for (const cell of SECRET_CELLS) {
			it(cell.name, async () => {
				const harness = await chainedHarness(harnesses, { persistSession: true });
				const errorMessage = `${cell.text}\n${modelNotFound}`;
				harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

				await harness.session.prompt("hello");

				const [event] = harness.eventsOfType("model_config_error");
				expect(event?.errorExcerpt).toMatch(/\[REDACTED\]/);
				expect(event?.errorExcerpt).not.toContain(cell.secret);
				expect(event?.errorExcerpt).toContain("model_not_found");
				expect(lastErrorMessage(harness)).not.toContain(cell.secret);
				expect(persistedSessionText(harness)).toContain("model_not_found");
				expect(persistedSessionText(harness)).not.toContain(cell.secret);
				expect(fallbackLogText(harness)).toMatch(/\[REDACTED\]/i);
				expect(fallbackLogText(harness)).not.toContain(cell.secret);
			});
		}

		it("keeps model ids, error codes and request ids readable", async () => {
			const harness = await chainedHarness(harnesses, { persistSession: true });
			const errorMessage = `${modelNotFound} ${READABLE_PROVIDER_TEXT}`;
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			await harness.session.prompt("hello");

			expect(harness.eventsOfType("model_config_error")).toMatchObject([{ errorExcerpt: errorMessage }]);
			expect(lastErrorMessage(harness)).toBe(errorMessage);
			expect(persistedSessionText(harness)).toContain(JSON.stringify(errorMessage).slice(1, -1));
		});
	});
});
