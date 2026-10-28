import { describe, expect, it } from "vitest";

import {
	compilePatterns,
	MatcherCompileError,
	scanPattern,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { RegExpLineMatcher } from "./support.ts";

describe("line matcher port", () => {
	it("hands the engine one group spelling, leaving escapes and classes alone", () => {
		const engine = new RegExpLineMatcher();
		const patterns = [String.raw`a(?P<x>\d)`, String.raw`(?<y>\w+)`, String.raw`[(?P<]\(?P<z>`];
		const compiled = compilePatterns(engine, patterns);
		expect(engine.compiled).toEqual([[String.raw`a(?<x>\d)`, String.raw`(?<y>\w+)`, String.raw`[(?P<]\(?P<z>`]]);
		expect(compiled.groupNames).toEqual([["x"], ["y"], []]);
	});

	const scans: [string, string, string | undefined][] = [
		["lookahead", "a(?=b)", "lookaround"],
		["negative lookbehind", "(?<!a)b", "lookaround"],
		["numbered backreference", String.raw`(a)\1`, "backreference"],
		["lookaround text inside a class", "[(?=]+", undefined],
		["an escaped paren before ?=", String.raw`\(?=`, undefined],
		["a class opening with ]", String.raw`[]\d](?<n>\d)`, undefined],
		["a non-capturing group", "(?:a|b)", undefined],
	];

	it.each(scans)("scans %s", (_name, pattern, error) => {
		const scan = scanPattern(pattern);
		if (error === undefined) expect(scan.error).toBeUndefined();
		else expect(scan.error).toContain(error);
	});

	it("reports the rejected pattern's index", () => {
		const engine = new RegExpLineMatcher();
		let caught: unknown;
		try {
			compilePatterns(engine, ["ok", "(?<=x)y"]);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(MatcherCompileError);
		expect(caught).toMatchObject({ pattern: 1, reason: expect.stringContaining("lookaround") });
		// The engine never sees a batch holding a rejected pattern.
		expect(engine.compiled).toEqual([]);
	});
});
