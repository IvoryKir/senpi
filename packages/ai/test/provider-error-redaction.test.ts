// The provider error boundary owns credential redaction for every pi-ai consumer: `redactSecrets` masks values by
// the shape they appear in, `sanitizeProviderErrorMessage` classifies a model configuration error on the raw text and
// keeps only the redacted text (senpi#4282). Fixture secrets are assembled at runtime and low-entropy so secret
// scanners never read them as real keys.

import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { redactSecrets, sanitizeProviderErrorMessage } from "../src/utils/provider-error.ts";

const secret = ["zzfixture", "4283", "valueQ"].join("");
const json = (value: unknown): string => JSON.stringify(value);

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
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE',
	"model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678",
];

const MB = 1 << 20;
const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);

// Inputs that made the previous name pattern retry one long run from every position (quadratic), plus every other
// rule's worst case: separators, cookie pairs, objects, XML, userinfo, bearer, prefixes and long names.
const ADVERSARIAL: readonly (readonly [label: string, text: string])[] = [
	["a keyword repeated", fill("key")],
	["a separated keyword repeated", fill("token_")],
	["a keyword inside a word repeated", fill("aaaaakey")],
	["short credential values repeated", fill("key: a ")],
	["separators repeated", fill("a:")],
	["whitespace after a credential name", `key:${" ".repeat(MB)}`],
	["cookie pairs repeated", `Cookie: ${fill("a=1; ")}`],
	["cookie names repeated", fill("Cookie: ")],
	["open credential objects repeated", fill("api_key: {")],
	["XML credential tags repeated", fill("<apiKey>")],
	["URL userinfo heads repeated", fill("https://u:")],
	["bearer schemes repeated", fill("bearer ")],
	["quotes after a name", `key${fill('\\"')}`],
	["names past the length bound", fill(`${"a".repeat(129)}_api_key: x `)],
];

function minMs(run: () => void): number {
	let best = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < 3; attempt++) {
		const start = performance.now();
		run();
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

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

	for (const [label, text] of ADVERSARIAL) {
		it(`stays linear on 1 MB of ${label}`, () => {
			expect(minMs(() => redactSecrets(text))).toBeLessThan(50);
		});
	}

	it("keeps a 1 MB adversarial error body linear at the stream boundary", () => {
		const elapsed = minMs(() => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "error", reason: "error", error: failedMessage(fill("aaaaakey")) });
		});
		expect(elapsed).toBeLessThan(50);
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
