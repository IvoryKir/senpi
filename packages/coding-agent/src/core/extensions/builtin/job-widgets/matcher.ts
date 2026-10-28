/**
 * The line-matching port. Widget patterns are model-written, so the production engine must run in
 * linear time (RE2 semantics); a JS `RegExp` can backtrack catastrophically and is not shipped as
 * an engine. {@link compilePatterns} rejects what RE2 cannot run (lookaround, backreferences) before
 * an engine sees a pattern, and hands it one group spelling, `(?<name>…)`.
 */

/** Span of one named group's capture in a line, in UTF-16 units. */
export interface GroupSpan {
	start: number;
	end: number;
}

export interface LineMatch {
	/** Index of the matched line in the input. */
	line: number;
	/** Index of the pattern that matched. */
	pattern: number;
	/** Per named group of the pattern, in `groupNames[pattern]` order; `undefined` when it took no part. */
	spans: readonly (GroupSpan | undefined)[];
}

export interface CompiledLineMatcher {
	/** Named groups of each pattern, in pattern order. */
	readonly groupNames: readonly (readonly string[])[];
	/** Every pattern's leftmost match on every line, ordered by line, then by pattern. */
	matchLines(lines: readonly string[]): LineMatch[];
}

/** A linear-time regex engine. `compile` throws {@link MatcherCompileError} for a pattern it rejects. */
export interface LineMatcher {
	compile(patterns: readonly string[]): CompiledLineMatcher;
}

export class MatcherCompileError extends Error {
	/** Index of the rejected pattern. */
	readonly pattern: number;
	readonly reason: string;

	constructor(pattern: number, reason: string) {
		super(`pattern ${pattern}: ${reason}`);
		this.name = "MatcherCompileError";
		this.pattern = pattern;
		this.reason = reason;
	}
}

export interface PatternScan {
	/** Named groups in pattern order. */
	groups: string[];
	/** The pattern with every `(?P<name>` spelled `(?<name>`. */
	normalized: string;
	/** Why the pattern cannot run on a linear-time engine. */
	error?: string;
}

const NAMED_GROUP_AT = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/;

/**
 * Reads a pattern's named groups and constructs outside escapes, character classes and `\Q\E`
 * quoted text (literal in RE2, up to `\E` or the end of the pattern), so the groups it reports are
 * the ones RE2's `namedGroups()` reports.
 */
export function scanPattern(pattern: string): PatternScan {
	const groups: string[] = [];
	let normalized = "";
	let inClass = false;
	const fail = (error: string): PatternScan => ({ groups, normalized: pattern, error });
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "\\") {
			const next = pattern.charAt(index + 1);
			if (!inClass && next === "Q") {
				const close = pattern.indexOf("\\E", index + 2);
				const end = close < 0 ? pattern.length : close + 2;
				normalized += pattern.slice(index, end);
				index = end - 1;
				continue;
			}
			if (!inClass && next >= "1" && next <= "9") return fail(`backreference \\${next} is not supported`);
			if (!inClass && next === "k" && pattern.charAt(index + 2) === "<") {
				return fail("named backreference \\k<…> is not supported");
			}
			normalized += char + next;
			index += 1;
			continue;
		}
		if (inClass) {
			if (char === "]") inClass = false;
			normalized += char;
			continue;
		}
		if (char === "[") {
			inClass = true;
			normalized += char;
			// A `]` right after `[` or `[^` is a literal member, not the class end.
			if (pattern.charAt(index + 1) === "^") normalized += pattern.charAt(++index);
			if (pattern.charAt(index + 1) === "]") normalized += pattern.charAt(++index);
			continue;
		}
		if (char === "(" && pattern.charAt(index + 1) === "?") {
			const kind = pattern.slice(index + 2, index + 4);
			if (kind.startsWith("=") || kind.startsWith("!") || kind === "<=" || kind === "<!") {
				return fail("lookaround (?=, (?!, (?<=, (?<! is not supported");
			}
			const named = NAMED_GROUP_AT.exec(pattern.slice(index));
			if (named) {
				groups.push(named[1]);
				normalized += `(?<${named[1]}>`;
				index += named[0].length - 1;
				continue;
			}
		}
		normalized += char;
	}
	return { groups, normalized };
}

/** Named groups a pattern declares, in pattern order. */
export function patternGroupNames(pattern: string): string[] {
	return scanPattern(pattern).groups;
}

/** Checks every pattern's syntax, then compiles the normalized patterns on `matcher`. */
export function compilePatterns(matcher: LineMatcher, patterns: readonly string[]): CompiledLineMatcher {
	const normalized = patterns.map((pattern, index) => {
		const scan = scanPattern(pattern);
		if (scan.error !== undefined) throw new MatcherCompileError(index, scan.error);
		return scan.normalized;
	});
	return matcher.compile(normalized);
}
