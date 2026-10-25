// Every secret shape a provider or gateway can echo in an error body, in every container it arrives in.
// Fixture secrets are assembled at runtime and low-entropy so secret scanners never read them as real keys.

export interface SecretShape {
	readonly label: string;
	readonly key: string;
	readonly value: string;
	readonly secret: string;
	readonly urlKey: string;
}

export interface SecretCell {
	readonly name: string;
	readonly secret: string;
	readonly text: string;
}

function named(label: string, key: string, secret: string, value = secret, urlKey = key): SecretShape {
	return { label, key, value, secret, urlKey };
}

function bare(label: string, secret: string): SecretShape {
	return { label, key: "detail", value: `rejected ${secret}`, secret, urlKey: "detail" };
}

const bearer = ["bearer", "fixture", "0001"].join("-");
const cookie = ["cookie", "fixture", "0004"].join("-");
const setCookie = ["sid", "fixture", "0005"].join("-");

export const SECRET_SHAPES: readonly SecretShape[] = [
	named("Authorization: Bearer", "Authorization", bearer, `Bearer ${bearer}`, "access_token"),
	named("x-api-key", "x-api-key", ["xkey", "fixture", "0002"].join("-"), undefined, "api_key"),
	named("api-key", "api-key", ["akey", "fixture", "0003"].join("-")),
	named("token", "token", ["token", "fixture", "0011"].join("-")),
	named("cookie", "Cookie", cookie, `session=${cookie}; theme=dark`),
	named("set-cookie", "Set-Cookie", setCookie, `sid=${setCookie}; Path=/; HttpOnly`),
	bare("sk-", `sk-${"proj"}FIXTURE0006`),
	bare("sk-ant-", `sk-${"ant-api03-"}FIXTURE0007`),
	bare("ghp_", `ghp_${"FIXTURE".repeat(3)}0008`),
	bare("github_pat_", `github_pat_${"FIXTURE".repeat(3)}_0009`),
	bare("AKIA", `AKIA${"FIXTURE"}000000010`),
	bare("JWT", [`eyJ${"hbGciOiJub25lIn0"}`, `eyJ${"zdWIiOiJmaXh0dXJlIn0"}`, `Zml4dHVyZS1zaWc${"x"}`].join(".")),
];

const CONTAINERS: readonly { label: string; render: (shape: SecretShape) => string }[] = [
	{ label: "header line", render: (shape) => `${shape.key}: ${shape.value}` },
	{ label: "JSON body", render: (shape) => JSON.stringify({ [shape.key]: shape.value }) },
	{
		label: "nested JSON",
		render: (shape) => JSON.stringify({ error: { request: { headers: { [shape.key]: shape.value } } } }),
	},
	{
		label: "JSON inside a JSON string",
		render: (shape) => JSON.stringify({ message: JSON.stringify({ [shape.key]: shape.value }) }),
	},
	{
		label: "URL query",
		render: (shape) =>
			`https://gateway.example.test/v1/chat?model=faux-1&${shape.urlKey}=${encodeURIComponent(shape.value)}&stream=true`,
	},
];

export const SECRET_CELLS: readonly SecretCell[] = SECRET_SHAPES.flatMap((shape) =>
	CONTAINERS.map((container) => ({
		name: `${shape.label} in ${container.label}`,
		secret: shape.secret,
		text: container.render(shape),
	})),
);

// Diagnostic text that must stay readable: model ids, error codes, request ids, token counts.
export const READABLE_PROVIDER_TEXT =
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE, model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678';
