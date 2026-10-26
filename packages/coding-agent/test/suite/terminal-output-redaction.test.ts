import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";

const pty = vi.hoisted(() => {
	class TerminalSession {
		private data = new Set<(chunk: Uint8Array) => void>();
		private exit = new Set<() => void>();
		constructor() {
			pty.sessions.push(this);
		}
		onData(fn: (chunk: Uint8Array) => void) {
			this.data.add(fn);
			return () => this.data.delete(fn);
		}
		onExit(fn: () => void) {
			this.exit.add(fn);
			return () => this.exit.delete(fn);
		}
		start() {}
		emit(text: string) {
			for (const fn of this.data) fn(new TextEncoder().encode(text));
		}
		finish() {
			for (const fn of this.exit) fn();
		}
	}
	class TerminalScreen {
		text = "";
		feed(text: string) {
			this.text += text;
			return Promise.resolve();
		}
		flush() {
			return Promise.resolve();
		}
		snapshot() {
			return { visibleGrid: [this.text], scrollback: [], cols: 120, rows: 40, cursor: { x: 0, y: 0 } };
		}
		dispose() {}
	}
	return { TerminalSession, TerminalScreen, sessions: [] as TerminalSession[] };
});
vi.mock("@earendil-works/pi-pty", () => pty);

import { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { loadTerminalSettings } from "../../src/core/extensions/builtin/terminal/settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("persistent terminal output redaction", () => {
	it("loads the opt-in setting and defaults to off", () => {
		expect(loadTerminalSettings(SettingsManager.inMemory()).redactSecretsInOutput).toBe(false);
		expect(
			loadTerminalSettings(
				SettingsManager.inMemory({
					tools: { bash: { redactSecretsInOutput: true } },
				}),
			).redactSecretsInOutput,
		).toBe(true);
	});

	it.each([false, true])("protects observers, delta, retained output and screen (enabled=%s)", async (enabled) => {
		const runtime = new TerminalRuntimeSession("synthetic", { redactSecretsInOutput: enabled });
		const session = pty.sessions.at(-1);
		assert(session);
		const observed: string[] = [];
		runtime.onOutput((text) => observed.push(text));
		const fixtures = secretOutputCases();
		const input = fixtures.map(({ input }) => input).join("\n");
		const expected = enabled ? fixtures.map(({ expected }) => expected).join("\n") : input;
		try {
			for (const character of input) {
				session.emit(character);
				if (enabled) expect(expected.startsWith(observed.join(""))).toBe(true);
			}
			session.finish();
			await runtime.screenReleased();
			expect(runtime.fullOutput()).toBe(expected);
			expect(runtime.readDelta().text).toBe(expected);
			expect(runtime.readDelta().text).toBe("");
			expect(observed.join("")).toBe(expected);
			expect(runtime.snapshot().visibleGrid).toEqual([expected]);
		} finally {
			runtime.dispose();
		}
	});
});
