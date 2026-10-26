import type { Context } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { coldSeedCalibration, estimateColdSeedTokens } from "./cold-seed-budget.ts";
import type { ContentBlockParam } from "./sdk-boundary.ts";

// Match the Claude-family safety margin used by model-usability-budget.ts. Until
// a billed prefix exists, Claude Code's own preamble is absent from both estimates.
const FIRST_TURN_PREAMBLE_RESERVE = 16_384;

/** Budget a fallback without scaling already billed usage by the cold-seed ratio. */
export function estimateLongContextFallbackTokens(
	context: Context,
	blocks: readonly ContentBlockParam[],
	sessionId: string | undefined,
): number {
	const usage = estimateContextTokens(context.messages);
	const calibration = coldSeedCalibration(sessionId);
	return (
		Math.max(
			usage.usageTokens + Math.ceil(usage.trailingTokens * calibration),
			Math.ceil(estimateColdSeedTokens(context, blocks) * calibration),
		) + (usage.lastUsageIndex === null ? FIRST_TURN_PREAMBLE_RESERVE : 0)
	);
}
