import { redactResolvedReferenceValues } from "./config-reference-redaction.ts";

export function redactSensitiveOutput(text: string): string {
	return redactSensitiveTokenValues(
		text
			.replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s'"]+)/g, "$1=[REDACTED]")
			.replace(/\b(Authorization:\s*Bearer\s+)([^\s'"]+)/gi, "$1[REDACTED]")
			.replace(/\b(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, "$1[REDACTED]"),
	);
}

export function redactSensitiveTokenValues(text: string, replacement = "[REDACTED]"): string {
	return redactResolvedReferenceValues(text, replacement)
		.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, replacement)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement);
}

// Header, JSON-field and query names whose value is a credential, matched as whole names so `max_tokens`
// or `token_type` never match `token`.
const KEY_NAMES = String.raw`x-api-key|x-goog-api-key|api[-_]?key|apikey|(?:access|refresh|id)[-_]?token|token|client[-_]?secret|secret|password`;
const SECRET_NAMES = String.raw`(?:proxy-)?authorization|(?:set-)?cookie|${KEY_NAMES}`;
// A value an earlier rule already replaced is left alone, so the rules compose in any order.
const FRESH = String.raw`(?!\[redacted\])`;
const VALUE = String.raw`[^\s"',;&{}[\]\\]+`;
const SECRET_RULES: readonly (readonly [pattern: RegExp, prefix: string, suffix: string])[] = [
	// JSON fields, plain and escaped inside a JSON string, and a set-cookie array.
	[new RegExp(String.raw`("(?:${SECRET_NAMES})"\s*:\s*")${FRESH}(?:[^"\\]|\\.)*(?=")`, "gi"), "$1", ""],
	[new RegExp(String.raw`(\\"(?:${SECRET_NAMES})\\"\s*:\s*\\")${FRESH}.*?(?=\\")`, "gi"), "$1", ""],
	[/("(?:set-)?cookie"\s*:\s*\[)[^\]]*/gi, '$1"', '"'],
	// URL query parameters.
	[new RegExp(String.raw`([?&;](?:${SECRET_NAMES})=)${FRESH}[^&#\s"'\\]+`, "gi"), "$1", ""],
	// Header lines and name=value text. A cookie value runs to the end of its line.
	[new RegExp(String.raw`\b((?:set-)?cookie\s*[:=]\s*)${FRESH}[^\r\n"\\]+`, "gi"), "$1", ""],
	[
		new RegExp(
			String.raw`\b((?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?)(?!(?:bearer|basic|token)\s)${FRESH}${VALUE}`,
			"gi",
		),
		"$1",
		"",
	],
	[new RegExp(String.raw`\b((?:${KEY_NAMES})\s*[:=]\s*)${FRESH}${VALUE}`, "gi"), "$1", ""],
	[new RegExp(String.raw`\b(bearer\s+)${FRESH}${VALUE}`, "gi"), "$1", ""],
	// Credential-shaped values wherever they appear; a letter before the prefix means an ordinary word.
	[/(?<![A-Za-z])sk-[A-Za-z0-9_-]{8,}/g, "", ""],
	[/(?<![A-Za-z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g, "", ""],
	// A JWT's header segment is base64url JSON, so it always begins with `eyJ`.
	[/(?<![A-Za-z])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "", ""],
	[/(?<![A-Za-z])ghp_[A-Za-z0-9]{20,}/g, "", ""],
	[/(?<![A-Za-z])github_pat_[A-Za-z0-9_]{20,}/g, "", ""],
];

/**
 * Redact every credential shape a provider or gateway can echo in an error body (headers, JSON bodies,
 * escaped JSON, URL queries, bare keys and tokens). Every sink of provider error text uses this one rule set.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	let redacted = redactSensitiveOutput(text);
	if (replacement !== "[REDACTED]") redacted = redacted.replaceAll("[REDACTED]", replacement);
	for (const [pattern, prefix, suffix] of SECRET_RULES) {
		redacted = redacted.replace(pattern, `${prefix}${replacement}${suffix}`);
	}
	return redacted;
}
