// Every secret shape a provider or gateway can echo in an error body, generated across key spellings, quoting and
// containers, plus the exact inputs a review found leaking. Fixture secrets are assembled at runtime and
// low-entropy so secret scanners never read them as real keys.

export interface SecretCell {
	readonly name: string;
	readonly secret: string;
	readonly text: string;
}

const secretFor = (index: number): string => `zzfixture${String(index).padStart(4, "0")}valueQ`;

// Key spellings: case, "-", "_", ".", compound prefixes and the header names gateways echo.
const KEY_SPELLINGS: readonly string[] = [
	"api_key",
	"api-key",
	"API-KEY",
	"Api.Key",
	"apikey",
	"x-api-key",
	"X-Api-Key",
	"x-goog-api-key",
	"key",
	"token",
	"access_token",
	"session_token",
	"openai_api_key",
	"OPENAI_API_KEY",
	"aws_secret_access_key",
	"private_key",
	"client_secret",
	"password",
	"Authorization",
	"Cookie",
	"Set-Cookie",
];

function valueFor(key: string, secret: string): string {
	if (key === "Authorization") return `Bearer ${secret}`;
	if (key === "Cookie") return `session=${secret}; theme=dark`;
	if (key === "Set-Cookie") return `sid=${secret}; Path=/; HttpOnly`;
	return secret;
}

const json = (value: unknown): string => JSON.stringify(value);

const CONTAINERS: readonly (readonly [label: string, render: (key: string, value: string) => string])[] = [
	["header line", (key, value) => `${key}: ${value}`],
	["double-quoted header value", (key, value) => `${key}: "${value}"`],
	["single-quoted header value", (key, value) => `${key}: '${value}'`],
	["backtick-quoted header value", (key, value) => `${key}: \`${value}\``],
	["JSON", (key, value) => json({ [key]: value })],
	["nested JSON", (key, value) => json({ error: { request: { headers: { [key]: value } } } })],
	["JSON array value", (key, value) => json({ headers: { [key]: [value] } })],
	["escaped JSON", (key, value) => json({ message: json({ [key]: value }) })],
	["doubly escaped JSON", (key, value) => json({ body: json({ message: json({ [key]: value }) }) })],
	["Go map", (key, value) => `map[${key}:[${value}] Content-Type:[application/json]]`],
	["Python repr", (key, value) => `{'${key}': '${value}', 'model': 'faux-1'}`],
	[
		"URL query",
		(key, value) =>
			`https://gateway.example.test/v1/chat?model=faux-1&${key}=${encodeURIComponent(value)}&stream=true`,
	],
	["form body", (key, value) => `model=faux-1&${key}=${encodeURIComponent(value)}&stream=true`],
];

// Credential-shaped values recognized by their prefix wherever they appear, under a name that says nothing.
const PREFIXED_SECRETS: readonly (readonly [label: string, secret: string])[] = [
	["sk-", `sk-${"proj"}FIXTURE0006`],
	["sk-ant-", `sk-${"ant-api03-"}FIXTURE0007`],
	["ghp_", `ghp_${"FIXTURE".repeat(3)}0008`],
	["github_pat_", `github_pat_${"FIXTURE".repeat(3)}_0009`],
	["AKIA", `AKIA${"FIXTURE"}000000010`],
	["AIza", `AIza${"FIXTURE".repeat(5)}0011`],
	["JWT", [`eyJ${"hbGciOiJub25lIn0"}`, `eyJ${"zdWIiOiJmaXh0dXJlIn0"}`, `Zml4dHVyZS1zaWc${"x"}`].join(".")],
];

const named: SecretCell[] = KEY_SPELLINGS.flatMap((key, keyIndex) =>
	CONTAINERS.map(([label, render], containerIndex) => {
		const secret = secretFor(keyIndex * CONTAINERS.length + containerIndex);
		return { name: `${key} in ${label}`, secret, text: render(key, valueFor(key, secret)) };
	}),
);

const prefixed: SecretCell[] = PREFIXED_SECRETS.flatMap(([prefix, secret]) =>
	CONTAINERS.map(([label, render]) => ({
		name: `bare ${prefix} in ${label}`,
		secret,
		text: render("detail", `rejected ${secret}`),
	})),
);

// The exact inputs the senpi#4283 delta review saw leak.
const reviewSecret = ["zzsecretzz", "123456"].join("");
const REVIEW_CELLS: readonly SecretCell[] = [
	{ name: "review: x-api-key header on the event stream", secret: reviewSecret, text: `x-api-key: ${reviewSecret}` },
	{ name: "review: Python repr api_key", secret: secretFor(9001), text: `{'api_key': '${secretFor(9001)}'}` },
	{ name: "review: quoted header value", secret: secretFor(9002), text: `api-key: "${secretFor(9002)}"` },
	{ name: "review: header array", secret: secretFor(9003), text: json({ "x-api-key": [secretFor(9003)] }) },
	{ name: "review: Go header map", secret: secretFor(9004), text: `map[X-Api-Key:[${secretFor(9004)}]]` },
	{
		name: "review: Google ?key=",
		secret: secretFor(9005),
		text: `https://generativelanguage.example.test/v1beta/models?key=${secretFor(9005)}`,
	},
	{
		name: "review: Google ?KEY=",
		secret: secretFor(9006),
		text: `https://generativelanguage.example.test/v1beta/models?KEY=${secretFor(9006)}`,
	},
	{ name: "review: openai_api_key", secret: secretFor(9007), text: `openai_api_key=${secretFor(9007)}` },
	{ name: "review: private_key", secret: secretFor(9008), text: `private_key: ${secretFor(9008)}` },
	{
		name: "review: aws_secret_access_key",
		secret: secretFor(9009),
		text: `aws_secret_access_key = ${secretFor(9009)}`,
	},
	{
		name: "review: doubly escaped JSON",
		secret: secretFor(9010),
		text: json(json(json({ "api-key": secretFor(9010) }))),
	},
	{
		name: "review: bare AIza key",
		secret: PREFIXED_SECRETS[5]?.[1] ?? "",
		text: `key ${PREFIXED_SECRETS[5]?.[1] ?? ""} rejected`,
	},
];

export const SECRET_CELLS: readonly SecretCell[] = [...REVIEW_CELLS, ...named, ...prefixed];

// Diagnostic text that must stay readable: model ids, error codes, request ids, token counts.
export const READABLE_PROVIDER_TEXT =
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE, model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678';
