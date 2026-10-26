import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type BashToolDetails, createBashTool } from "../../src/core/tools/bash.ts";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("opt-in bash output redaction", () => {
	it("keeps stdout and stderr token boundaries independent", async () => {
		const fixture = secretOutputCases()[0];
		assert(fixture);
		const tool = createBashTool(process.cwd(), {
			redactSecretsInOutput: true,
			operations: {
				async exec(_command, _cwd, { onData }) {
					onData(Buffer.from(fixture.input.slice(0, 2)), "stdout");
					onData(Buffer.from("diagnostic\n"), "stderr");
					onData(Buffer.from(fixture.input.slice(2)), "stdout");
					return { exitCode: 0 };
				},
			},
		});
		expect(getMessageText(await tool.execute("interleaved", { command: "synthetic" }))).toBe(
			"diagnostic\n<redacted>",
		);
	});
	for (const fixture of secretOutputCases()) {
		it.each(["stdout", "stderr"] as const)(
			`redacts ${fixture.name} across every %s chunk boundary`,
			async (stream) => {
				for (let split = 1; split < fixture.input.length; split++) {
					const updates: string[] = [];
					const tool = createBashTool(process.cwd(), {
						redactSecretsInOutput: true,
						operations: {
							async exec(_command, _cwd, { onData }) {
								onData(Buffer.from(fixture.input.slice(0, split)), stream);
								onData(Buffer.from(`${fixture.input.slice(split)}\n`), stream);
								return { exitCode: 0 };
							},
						},
					});
					const result = await tool.execute("redact", { command: "synthetic" }, undefined, (update) => {
						updates.push(getMessageText(update));
					});
					expect(getMessageText(result)).toBe(`${fixture.expected}\n`);
					expect(result.structuredContent).toMatchObject({ output: `${fixture.expected}\n` });
					for (const update of updates) expect(`${fixture.expected}\n`.startsWith(update)).toBe(true);
				}
			},
		);
	}

	it.each([undefined, false])("preserves output when option is %s", async (enabled) => {
		const input = secretOutputCases()
			.map(({ input }) => input)
			.join("\n");
		const tool = createBashTool(process.cwd(), {
			redactSecretsInOutput: enabled,
			operations: {
				async exec(_command, _cwd, { onData }) {
					onData(Buffer.from(input));
					return { exitCode: 0 };
				},
			},
		});
		expect(getMessageText(await tool.execute("off", { command: "synthetic" }))).toBe(input);
	});

	it.each([false, true])("applies the setting before spilling every secret class (enabled=%s)", async (enabled) => {
		const fixtures = secretOutputCases();
		const raw = fixtures.map(({ input }) => input).join("\n");
		const clean = fixtures.map(({ expected }) => expected).join("\n");
		const padding = "ordinary line\n".repeat(6000);
		const input = `${raw}\n${padding}${raw}`;
		const expected = enabled ? `${clean}\n${padding}${clean}` : input;
		const tool = createBashTool(process.cwd(), {
			redactSecretsInOutput: enabled,
			operations: {
				async exec(_command, _cwd, { onData }) {
					onData(Buffer.from(input));
					return { exitCode: 3 };
				},
			},
		});
		const result = await tool.execute("spill", { command: "synthetic" });
		const path = (result.details as BashToolDetails | undefined)?.fullOutputPath;
		assert(path);
		try {
			const spill = readFileSync(path, "utf8");
			expect(spill).toBe(expected);
			expect(result.structuredContent).toMatchObject({ output: expected });
			if (enabled) {
				for (const fixture of fixtures) expect(JSON.stringify(result)).not.toContain(fixture.input);
			}
			expect(result.isError).toBe(true);
		} finally {
			rmSync(path, { force: true });
		}
	});

	it.each(["aborted", "timeout:1"])("flushes redaction at an interrupted EOF (%s)", async (reason) => {
		const fixtures = secretOutputCases();
		const input = fixtures.map(({ input }) => input).join("\n");
		const expected = fixtures.map(({ expected }) => expected).join("\n");
		const tool = createBashTool(process.cwd(), {
			redactSecretsInOutput: true,
			operations: {
				async exec(_command, _cwd, { onData }) {
					for (const character of input) onData(Buffer.from(character), "stderr");
					throw new Error(reason);
				},
			},
		});
		const status = reason === "aborted" ? "Command aborted" : "Command timed out after 1 seconds";
		await expect(tool.execute("interrupted", { command: "synthetic" })).rejects.toThrow(`${expected}\n\n${status}`);
	});

	it.each([false, true])("applies settings to real stdout, stderr and transcript (enabled=%s)", async (enabled) => {
		const harness = await createHarness({
			persistSession: true,
			settings: { tools: { bash: { redactSecretsInOutput: enabled } } },
		});
		try {
			const fixtures = secretOutputCases();
			const input = fixtures.map(({ input }) => input).join("\n") + "\n";
			const expected = enabled ? fixtures.map(({ expected }) => expected).join("\n") + "\n" : input;
			// The command itself contains only encoded synthetic data, so the assistant tool-call entry is safe too.
			const encoded = Buffer.from(input).toString("base64");
			const script = `const x=Buffer.from("${encoded}","base64");process.stdout.write(x);process.stderr.write(x);`;
			const command = `${JSON.stringify(process.execPath)} -e '${script}'`;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Run the synthetic output probe.");
			const result = harness.session.messages.find((message) => message.role === "toolResult");
			expect(getMessageText(result)).toBe(expected + expected);
			const sessionFile = harness.sessionManager.getSessionFile();
			assert(sessionFile);
			const entries = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const persisted = entries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult");
			expect(getMessageText(persisted?.message)).toBe(expected + expected);
		} finally {
			harness.cleanup();
		}
	});
});
