// The provider error boundary owns credential redaction for every pi-ai consumer: `redactSecrets` masks values by
// the shape they appear in, `sanitizeProviderErrorMessage` classifies a model configuration error on the raw text and
// keeps only the redacted text (senpi#4282). Fixture secrets are assembled at runtime and low-entropy so secret
// scanners never read them as real keys.

import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { redactSecrets, sanitizeProviderErrorMessage } from "../src/utils/provider-error.ts";

const secret = ["zzfixture", "4283", "valueQ"].join("");
const json = (value: unknown): string => JSON.stringify(value);
const ghp = `ghp_${"FIXTURE".repeat(3)}0008`;
const sk = `sk-${"proj"}FIXTURE0006`;
const jwt = ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJmaXh0dXJlIn0", "Zml4dHVyZS1zaWcx"].join(".");

const REDACTED_SHAPES: readonly (readonly [label: string, text: string, leaked: string])[] = [
	["header line", `x-api-key: ${secret}`, secret],
	["camelCase JSON field", json({ apiKey: secret }), secret],
	["sessionToken query", `https://gateway.example.test/v1?sessionToken=${secret}`, secret],
	["session as the whole name", `session: ${secret}`, secret],
	["typographic quotes", `\u201Capi_key\u201D: \u201C${secret}\u201D`, secret],
	["full-width colon", `api_key\uFF1A ${secret}`, secret],
	["XML element", `<apiKey>${secret}</apiKey>`, secret],
	["HTML-escaped XML element", `&lt;apiKey&gt;${secret}&lt;/apiKey&gt;`, secret],
	["HTML-escaped JSON", `&quot;api_key&quot;: &quot;${secret}&quot;`, secret],
	["nested credentials object", json({ error: { credentials: { type: "service", value: secret } } }), secret],
	["escaped nested credentials object", json(json({ credentials: { value: secret } })), secret],
	["URL userinfo", `https://user:${secret}@gateway.example.test/v1`, secret],
	["short URL userinfo password", "https://user:pw@gateway.example.test/v1", ":pw@"],
	["Azure SAS signature", `https://acct.blob.example.test/c/b?sv=2024-11-04&sr=b&sig=${secret}`, secret],
	["second cookie pair after a short first", `Cookie: a=1; __cf_bm=${secret}`, secret],
	["short cookie value", "Cookie: a=1; sid=s3cr3t", "s3cr3t"],
	["set-cookie array", json({ "set-cookie": ["a=1", `sid=${secret}`] }), secret],
	["escaped set-cookie array", json(json({ "set-cookie": ["a=1", `sid=${secret}`] })), secret],
	["URL-encoded cookie", `model=faux-1&Cookie=${encodeURIComponent(`a=1; sid=${secret}`)}&stream=true`, secret],
	["gsk_ prefix", `rejected gsk_${"FIXTURE".repeat(3)}0012`, `gsk_${"FIXTURE".repeat(3)}0012`],
	["xai- prefix", `rejected xai-${"FIXTURE".repeat(3)}0013`, `xai-${"FIXTURE".repeat(3)}0013`],
	["hf_ prefix", `rejected hf_${"FIXTURE".repeat(3)}0014`, `hf_${"FIXTURE".repeat(3)}0014`],
	["rk_live_ prefix", `rejected rk_${"live_"}${"FIXTURE".repeat(3)}0015`, `${"FIXTURE".repeat(3)}0015`],
	["xoxb- prefix", `rejected xox${"b-"}${"FIXTURE".repeat(2)}-0016`, `${"FIXTURE".repeat(2)}-0016`],
	["numbered environment name", `OPENAI_API_KEY_2=${secret}`, secret],
	["digits glued to the word", `token2: ${secret}`, secret],
	["numbered header name", `x-api-key-1: ${secret}`, secret],
	["value qualifier", json({ api_key_value: secret }), secret],
	["camelCase id qualifier", json({ apiKeyId: secret }), secret],
	["a field named bearer", json({ bearer: "abcdefgh1234" }), "abcdefgh1234"],
	["a 130-character name", json({ [`${"a".repeat(130)}_api_key`]: secret }), secret],
	["a long dotted path", `request.headers.${"x".repeat(120)}.authorization: ${secret}`, secret],
	["a short password", json({ password: "hunter2-shrt" }), "hunter2-shrt"],
	["a short Basic credential", `Authorization: Basic ${["dXNl", "cjpw", "YXNz"].join("")}`, "dXNlcjpwYXNz"],
	[
		"a JWT ending a sentence",
		`rejected ${["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJmaXh0dXJlIn0", "Zml4dHVyZS1zaWcx"].join(".")}.`,
		"eyJhbGci",
	],
	// Round 8: credential shapes inside a token (URL userinfo, paths, joined values), and whole strict values.
	["a token as git remote userinfo", `https://${ghp}@github.com/o/r.git`, ghp],
	["a token after git remote user:", `https://x-access-token:${ghp}@github.com/o/r.git`, ghp],
	["a key in a URL path segment", `/v1/keys/${sk}`, sk],
	["a key joined with +", `x+${sk}`, sk],
	["a key after ~/", `~/${sk}`, sk],
	["an AWS key id after /", `see /AKIA${"FIXTURE"}000000010`, "FIXTURE000000010"],
	["a JWT in a URL path", `/cb/${jwt}`, "eyJzdWIi"],
	["a JWT followed by a path", `/cb/${jwt}/more`, "eyJzdWIi"],
	["a key as proxy userinfo", `https://${sk}@proxy.example.test`, sk],
	["a token after user@", `deploy@${ghp}`, ghp],
	["a quoted password with punctuation", 'password: "Hunter2!zzTailA01"', "zzTailA01"],
	["a bare password with @ and :", "password=p@zzTailA02:word123", "zzTailA02"],
	["a non-ASCII password", json({ password: "p\u00e4sswzzTailA03" }), "zzTailA03"],
	["a quoted password with spaces", json({ password: "abc def zzTailA04" }), "zzTailA04"],
	["an escaped quoted authorization", json(json({ authorization: "Bearer abc zzTailA05" })), "zzTailA05"],
	["an XML password with punctuation", "<password>ab!zzTailA06</password>", "zzTailA06"],
];

// Names that contain a credential word without holding a credential, and diagnostics, stay byte-identical.
const READABLE_TEXT: readonly string[] = [
	'"monkey": "abcdefghijklmnopqrstuvwxyz"',
	"turkey=abcdefghijklmnopqrstuv",
	'"keyword": "abcdefghijklmnopqrstuvwxyz"',
	'"tokenizer": "cl100k_base_tokenizer_v2"',
	"primary_key_column=customer_identifier_column",
	"max_tokens: 1234567890123456789",
	"session_id: 0f8fad5b-d9cb-469f-a165-70867728950e",
	"token_type: bearer_access_token_v2_long",
	"authorization_endpoint=api.example.com/oauth2/authorize",
	"token_count: 12345678901234567890",
	"https://gateway.example.test:8443/v1/chat?model=faux-1&stream=true",
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE',
	"model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678",
	"tasks-abcdefghijk /srv/risk-assessment-v2 disk-cache-directory-1234 /opt/AKIA_notes",
];

function failedMessage(errorMessage: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

describe("redactSecrets", () => {
	for (const [label, text, leaked] of REDACTED_SHAPES) {
		it(`redacts ${label}`, () => {
			const redacted = redactSecrets(text);
			expect(redacted).toContain("[REDACTED]");
			expect(redacted).not.toContain(leaked);
			expect(redactSecrets(redacted)).toBe(redacted);
		});
	}

	for (const text of READABLE_TEXT) {
		it(`keeps ${text.slice(0, 40)} readable`, () => {
			expect(redactSecrets(text)).toBe(text);
		});
	}

	it("uses the caller's replacement", () => {
		expect(redactSecrets(`api_key=${secret}`, "[redacted]")).toBe("api_key=[redacted]");
	});

	it("keeps the URL around a credential found inside a token", () => {
		expect(redactSecrets(`https://${ghp}@github.com/o/r.git`)).toBe("https://[REDACTED]@github.com/o/r.git");
		expect(redactSecrets(`/v1/keys/${sk}`)).toBe("/v1/keys/[REDACTED]");
	});

	it("redacts a strict value up to its closing quote or field delimiter, keeping the structure", () => {
		expect(redactSecrets('password: "Hunter2!xyz9", next')).toBe('password: "[REDACTED]", next');
		expect(redactSecrets("password=p@ss:word123&model=faux-1")).toBe("password=[REDACTED]&model=faux-1");
		expect(redactSecrets(json({ password: 'a"b c', model: "faux-1" }))).toBe(
			json({ password: "[REDACTED]", model: "faux-1" }),
		);
	});
});

describe("sanitizeProviderErrorMessage", () => {
	const modelNotFound = `400 {"code":"model_not_found","message":"unknown provider for model faux-1"} x-api-key: ${secret}`;

	it("classifies a model configuration error on the raw text, then keeps only the redacted text", () => {
		const message = failedMessage(modelNotFound);
		sanitizeProviderErrorMessage(message);
		expect(message.errorCause).toEqual({ type: "model_config", model: "faux/faux-1" });
		expect(message.errorMessage).toContain("model_not_found");
		expect(message.errorMessage).not.toContain(secret);
	});

	for (const stopReason of ["aborted", "stop"] as const) {
		it(`does not classify a ${stopReason} message whose text mentions model_not_found`, () => {
			const message = failedMessage(modelNotFound, stopReason);
			sanitizeProviderErrorMessage(message);
			expect(message.errorCause).toBeUndefined();
			expect(message.errorMessage).not.toContain(secret);
		});
	}
});
