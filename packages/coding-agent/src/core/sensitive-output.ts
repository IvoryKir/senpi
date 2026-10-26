import { redactSecrets as redactProviderSecrets } from "@earendil-works/pi-ai";
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

/**
 * Every sink of provider error text uses this: the session's own rules (environment assignments, resolved config
 * references) and pi-ai's value-based credential redaction, the same rules the provider stream applies.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	const session = redactSensitiveOutput(text);
	const marked = replacement === "[REDACTED]" ? session : session.replaceAll("[REDACTED]", replacement);
	return redactProviderSecrets(redactSensitiveTokenValues(marked, replacement), replacement);
}
