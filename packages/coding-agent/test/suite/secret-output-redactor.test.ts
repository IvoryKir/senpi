import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { SecretOutputRedactor } from "../../src/core/tools/secret-output-redactor.ts";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";

describe("streaming secret tokenizer", () => {
	it("redacts punctuation inside an unquoted secret assignment", () => {
		const redactor = new SecretOutputRedactor();
		const input = "PASSWORD=synthetic,comma;tail/path after";
		expect(redactor.push(input) + redactor.finish()).toBe("PASSWORD=<redacted> after");
	});
	it("recognizes tokens across ANSI styling and discards hidden OSC payloads", () => {
		const fixture = secretOutputCases()[0];
		assert(fixture);
		const token = fixture.input;
		const input = `${token.slice(0, 2)}\x1b[31m${token.slice(2)}\x1b[0m\n\x1b]0;${token}\x07done`;
		const redactor = new SecretOutputRedactor();
		const output = [...input].map((c) => redactor.push(c)).join("") + redactor.finish();
		expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("<redacted>\ndone");
	});
	it("keeps redacted output stable when it crosses a second boundary", () => {
		const input = secretOutputCases()
			.map(({ expected }) => expected)
			.join("\n");
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(input) + redactor.finish()).toBe(input);
	});
	it("keeps ordinary text and Unicode unchanged", () => {
		const redactor = new SecretOutputRedactor();
		const input = "build v1.2.3 /tmp/out.txt COUNT=12\n\u65e5\u672c\u8a9e \u{1f431}\n";
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(input);
	});

	it("redacts an arbitrarily large undecided token without releasing a suffix", () => {
		const redactor = new SecretOutputRedactor();
		let output = "";
		for (let i = 0; i < 100; i++) output += redactor.push("a".repeat(4096));
		output += redactor.push("\nend") + redactor.finish();
		expect(output).toBe("<redacted>\nend");
		expect(redactor.finish()).toBe("");
	});

	it("keeps a quoted assignment private across escaped quotes and newlines", () => {
		const input = 'MY_SECRET="one \\" two\nthree" after';
		const redactor = new SecretOutputRedactor();
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe('MY_SECRET="<redacted>" after');
	});

	it("redacts an unterminated PEM block at EOF", () => {
		const fixture = secretOutputCases().find(({ name }) => name === "PEM");
		assert(fixture);
		const input = fixture.input.split("\n").slice(0, 2).join("\n");
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(input) + redactor.finish()).toBe("<redacted>");
	});

	it("redacts padded Bearer credentials and JWT headers with whitespace", () => {
		const jwt = [Buffer.from('{ "alg": "HS256" }').toString("base64url"), "payload", "signature"].join(".");
		const input = `Bearer ${["abc", "=def=="].join("")}\n${jwt}\n`;
		const redactor = new SecretOutputRedactor();
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(
			"Bearer <redacted>\n<redacted>\n",
		);
	});
});
