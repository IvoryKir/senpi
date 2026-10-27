import { describeGitHubCopilotFailure } from "@earendil-works/pi-ai/api/github-copilot-errors";
import { AllSlotsBlockedError } from "@earendil-works/pi-ai/auth/pool/select";
import { describe, expect, it } from "vitest";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../../../src/core/auth-guidance.ts";
import { formatCompactionFailure } from "../../../src/core/compaction-failure-text.ts";
import {
	CredentialFailoverError,
	type RunSlot,
	runCredentialFailover,
} from "../../../src/core/credential-pool/failover.ts";
import { sdkErrorGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/guidance.ts";
import type { ModelUsabilityBudgetProjection } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { providerAuthRecoveryHint } from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";
import { startupRefusalMessage } from "../../../src/core/startup-model-pick.ts";

// senpi#4329: texts that RPC and desktop clients show too must not name TUI-only commands,
// and a pool refusal keeps its typed due-back time and matched prefix.
const TUI_COMMAND = /(?:^|[\s(])\/(?:login|model|compact)\b/;
const NOW = Date.UTC(2026, 9, 27, 17, 0);
const DUE = NOW + 15 * 60_000;

async function refusal(slots: readonly RunSlot[]): Promise<CredentialFailoverError> {
	const stream = runCredentialFailover<{ type: string }, RunSlot>({
		listSlots: () => slots,
		select: (candidates) => {
			const slot = candidates[0];
			if (slot === undefined) throw new Error("no candidate slot");
			return slot;
		},
		runAttempt: async () => {
			throw new Error("no slot may run");
		},
		isCommittedOutput: () => true,
		persistBlock: () => {},
		now: () => NOW,
	});
	const outcome = await stream.next().then(
		() => undefined,
		(error: unknown) => error,
	);
	if (!(outcome instanceof CredentialFailoverError)) throw new Error("expected a pool refusal");
	return outcome;
}

const refused = { model: "faux/tiny", contextWindow: 1000, requiredTokens: 4000 } as ModelUsabilityBudgetProjection;
const copilot = (status: number) =>
	describeGitHubCopilotFailure(Object.assign(new Error(`${status} status code (no body)`), { status }));

describe("failure steps reaching RPC clients (senpi#4329)", () => {
	it.each([
		["no model selected", formatNoModelSelectedMessage()],
		["no API key", formatNoApiKeyFoundMessage("faux")],
		["goal 401", providerAuthRecoveryHint({ httpStatus: 401, provider: "faux", model: "tiny" })],
		["goal 403", providerAuthRecoveryHint({ httpStatus: 403, provider: "faux", model: "tiny" })],
		["startup automatic", startupRefusalMessage(refused, true)],
		["startup chosen", startupRefusalMessage(refused, false)],
		["claude auth", sdkErrorGuidance("auth_error")],
		["claude entitlement", sdkErrorGuidance("entitlement")],
		["copilot 421", copilot(421)],
		["copilot 403", copilot(403)],
		["pool re-login", new AllSlotsBlockedError(undefined).message],
		["compaction", formatCompactionFailure("compaction", "Connection error.")],
		["overflow", formatCompactionFailure("overflow-recovery", "Connection error.")],
	])("%s names no TUI-only command", (_label, text) => {
		expect(text).toBeDefined();
		expect(text).not.toMatch(TUI_COMMAND);
	});

	it.each([
		["cooling", [{ name: "a", blockReason: "auth_error", blockedUntil: DUE }], DUE],
		["disabled", [{ name: "a", blockReason: "account_disabled" }], undefined],
	] as const)("a %s pool keeps its prefix and typed due-back time", async (_label, slots, retryAt) => {
		const error = await refusal(slots);
		expect(error.message.startsWith("No credential slots available: a (")).toBe(true);
		expect(error.message).not.toMatch(TUI_COMMAND);
		expect(error.retryAt).toBe(retryAt);
		if (retryAt !== undefined) expect(error.message).not.toContain(new Date(retryAt).toISOString());
	});
});
