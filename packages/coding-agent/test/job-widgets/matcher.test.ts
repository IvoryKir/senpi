import { describe, expect, it } from "vitest";

import {
	compilePatterns,
	defaultLineMatcher,
	MatcherCompileError,
	patternGroupNames,
	scanPattern,
	validateJobWidgetSpec,
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
		["lookaround text inside a class opening with ]", "[](?=a)]", undefined],
		["lookaround text inside a negated class opening with ]", "[^](?=a)]", undefined],
		["a lookahead after a class opening with ]", "[]a](?=b)", "lookaround"],
		["lookaround and a backreference quoted by \\Q\\E", String.raw`\Q(?=a)\1\E`, undefined],
		["a lookahead after \\Q\\E", String.raw`\Qa\E(?=b)`, "lookaround"],
		["a non-capturing group", "(?:a|b)", undefined],
	];

	it.each(scans)("scans %s", (_name, pattern, error) => {
		const scan = scanPattern(pattern);
		if (error === undefined) expect(scan.error).toBeUndefined();
		else expect(scan.error).toContain(error);
	});

	it("reads a class opening with ] as RE2 does: `]` and the text up to the next `]` are members", () => {
		for (const pattern of ["[](?=a)]", "[^](?=a)]"]) {
			expect(scanPattern(pattern)).toEqual({ groups: [], normalized: pattern });
		}
	});

	const quoted: [string, string[]][] = [
		[String.raw`\Q(?<x>a)\E(?<y>\d)`, ["y"]],
		[String.raw`(?P<a>\d)\Q(?P<b>\E(?<c>x)`, ["a", "c"]],
		[String.raw`(?<a>\d)\Q(?<b>x)`, ["a"]],
		[String.raw`\\Q(?<a>x)\\E`, ["a"]],
	];

	it.each(quoted)("skips \\Q\\E quoted text in %s, naming the groups RE2 names", (pattern, groups) => {
		expect(patternGroupNames(pattern)).toEqual(groups);
		expect(compilePatterns(defaultLineMatcher, [pattern]).groupNames).toEqual([groups]);
	});

	it("rejects a spec whose field names a group inside \\Q\\E", () => {
		const spec = (field: string) => ({
			title: "quoted",
			rules: [{ from: "out", match: String.raw`\Q(?<x>a)\E(?<y>\d)` }],
			blocks: [{ kind: "stat", items: [{ field, agg: "last", label: field }] }],
		});
		const checked = validateJobWidgetSpec(spec("x"), { matcher: defaultLineMatcher });
		expect(checked.ok).toBe(false);
		expect(checked.ok ? [] : checked.errors).toContainEqual(expect.stringContaining('unknown field "x"'));
		expect(validateJobWidgetSpec(spec("y"), { matcher: defaultLineMatcher }).ok).toBe(true);
	});

	it("has the RegExp fake refuse what JS reads differently: a class opening with ], and \\Q\\E", () => {
		for (const pattern of ["[](?=a)]", "x[^](?=a)]", String.raw`[]\d](?<n>\d)`, String.raw`\Q(?<x>a)\E`]) {
			const engine = new RegExpLineMatcher();
			expect(() => engine.compile(["ok", pattern])).toThrow(MatcherCompileError);
		}
		for (const pattern of [String.raw`\[](?<n>\d)`, "[a]]", "[[]", String.raw`[\Q]`, String.raw`\\Q`]) {
			expect(() => new RegExpLineMatcher().compile([pattern]), pattern).not.toThrow();
		}
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
