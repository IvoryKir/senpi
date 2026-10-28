/**
 * Secrets never reach a widget author: the request controller passes every request through
 * {@link redactAuthorRequest} before any author (model-backed or host-injected) sees it, and before
 * the sample builder budgets a byte of it. The author only needs line shapes, never values.
 */
import { redactSecrets } from "../../../sensitive-output.ts";
import { SecretOutputRedactor } from "../../../tools/secret-output-redactor.ts";
import type { JobWidgetAuthorRequest, JobWidgetBrief } from "./author-types.ts";
import type { JobWidgetSourceSample } from "./source-stats.ts";

export type JobWidgetRedact = (text: string) => string;

/**
 * The session's own secret handling, run first (it knows exact secret values), then the built-in
 * rules, which apply even with secret handling off. `redactSecrets` runs `redactSensitiveOutput`
 * (environment assignments, `Authorization: Bearer`) before the value-based credential scan
 * (key prefixes such as `ghp_`/`sk-`/`AKIA`, JWTs, bearer tokens, secret-named values).
 */
export function createWidgetRedactor(obfuscate?: JobWidgetRedact): JobWidgetRedact {
	return (text) => redactSecrets(obfuscate ? obfuscate(text) : text);
}

/** A session obfuscator backed by the bash tool's streaming redactor, for sessions that turn it on. */
export function secretOutputObfuscator(text: string): string {
	const redactor = new SecretOutputRedactor();
	return redactor.push(text) + redactor.finish();
}

function redactOptional(text: string | undefined, redact: JobWidgetRedact): string | undefined {
	return text === undefined ? undefined : redact(text);
}

function redactBrief(brief: JobWidgetBrief, redact: JobWidgetRedact): JobWidgetBrief {
	return {
		kind: brief.kind,
		command: redactOptional(brief.command, redact),
		task: redactOptional(brief.task, redact),
		intent: redactOptional(brief.intent, redact),
		watch: redactOptional(brief.watch, redact),
		stage: redactOptional(brief.stage, redact),
	};
}

function redactSource(source: JobWidgetSourceSample, redact: JobWidgetRedact): JobWidgetSourceSample {
	return {
		id: source.id,
		label: redact(source.label),
		size: source.size,
		lines: source.lines,
		head: source.head.map(redact),
		tail: source.tail.map(redact),
	};
}

/** Every text field of `request` redacted: brief fields, source labels and lines, and retry text. */
export function redactAuthorRequest(request: JobWidgetAuthorRequest, redact: JobWidgetRedact): JobWidgetAuthorRequest {
	return {
		jobId: request.jobId,
		brief: redactBrief(request.brief, redact),
		sources: request.sources.map((source) => redactSource(source, redact)),
		previous: request.previous && { spec: request.previous.spec, reason: redact(request.previous.reason) },
		rejected: request.rejected && {
			answer: redact(request.rejected.answer),
			errors: request.rejected.errors.map(redact),
		},
	};
}
