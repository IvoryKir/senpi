import { describeProviderFailureForUser, stripTurnRetrySuppressionPrefix } from "@earendil-works/pi-ai";
import { usageLimitScope } from "./retry-fallback/usage-limit.ts";

export type CompactionFailureKind = "compaction" | "auto-compaction" | "overflow-recovery";

const LEAD: Record<CompactionFailureKind, string> = {
	compaction: "Compaction failed",
	"auto-compaction": "Auto-compaction failed",
	"overflow-recovery": "Context overflow recovery failed",
};

/** The two refusals core raises before any summary request; both already say what happened. */
const NOTHING_TO_COMPACT = /^(?:Nothing to compact|Already compacted)\b/;
/** Rejection and cancellation texts that already name their own next step. */
const SELF_EXPLAINED = /^Compaction (?:rejected|cancelled)\b/;

function explain(kind: CompactionFailureKind, cause: string, model: string | undefined): string {
	const provider = describeProviderFailureForUser(cause, { model, usageLimit: usageLimitScope(cause) });
	if (provider !== undefined) return provider;
	if (kind === "overflow-recovery") {
		return "The conversation is larger than the model's context, and compacting it did not finish. Start a new session, or switch to a larger-context model.";
	}
	if (NOTHING_TO_COMPACT.test(cause)) {
		return "There is nothing older to summarize yet, so the context was left as it is. No action is needed.";
	}
	return "The summary of the earlier conversation could not be written. Compact again; if it keeps failing, start a new session or choose another model.";
}

/**
 * The `compaction_end` failure text: the lead, the cause class with one next step that works on every
 * surface, then the raw cause as a diagnostic (senpi#4329). The raw text stays in the message so
 * consumers that read it (the TUI's transient-failure banner, overflow retry) see what they saw before.
 */
export function formatCompactionFailure(
	kind: CompactionFailureKind,
	error: string,
	options: { readonly model?: string } = {},
): string {
	const cause = stripTurnRetrySuppressionPrefix(error).trim();
	if (cause.length === 0) return `${LEAD[kind]}.`;
	if (SELF_EXPLAINED.test(cause)) return `${LEAD[kind]}: ${cause}`;
	return `${LEAD[kind]}: ${explain(kind, cause, options.model)} Cause: ${cause}`;
}
