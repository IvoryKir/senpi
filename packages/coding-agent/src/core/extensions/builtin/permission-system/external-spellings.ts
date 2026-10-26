import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { realpathWithoutOpenStrict } from "../../../../utils/paths.ts";
import { canonicalPathCase, sameLexicalPath } from "./external-pattern.ts";
import type { Rule } from "./types.ts";

type Decision = { readonly action: Rule["action"]; readonly rules: readonly Rule[] };

/**
 * Evaluate every partial symlink resolution, not just the lexical and resolved endpoints.
 * Keeping a link continues the component walk; following it queues a new spelling. Repeating
 * this for each queued spelling covers every subset, including keeping an earlier link while
 * following a later one. Discovery uses only lstat/readlink; case recovery is separate.
 */
export function decideExternalPaths(
	target: string | readonly string[],
	aliases: readonly string[],
	decide: (spelling: string, resolved: string, canonicalCase: (value: string) => string) => Decision,
): Decision {
	const targets = typeof target === "string" ? [target] : target;
	const resolvedPaths = new Map<string, string>();
	const cases = new Map<string, string>();
	const directories = new Map<string, string[]>();
	const canonicalCase = (value: string): string => {
		let result = cases.get(value);
		if (result === undefined) {
			result = canonicalPathCase(value, (directory) => {
				let entries = directories.get(directory);
				if (entries === undefined) {
					entries = readdirSync(directory);
					directories.set(directory, entries);
				}
				return entries;
			});
			cases.set(value, result);
		}
		return result;
	};
	const resolve = (value: string): string => {
		let result = resolvedPaths.get(value);
		if (result === undefined) {
			result = realpathWithoutOpenStrict(value);
			resolvedPaths.set(value, result);
		}
		return result;
	};
	const spellings = new Map<string, string>();
	const add = (spelling: string, resolved: string): boolean => {
		spellings.set(spelling, resolved);
		spellings.set(canonicalCase(spelling), resolved);
		return spellings.size <= 16;
	};
	let hops = 0;
	try {
		const resolvedTargets = targets.map(resolve);
		for (const value of new Set([...targets, ...aliases])) {
			const resolved = resolve(value);
			// A multi-path request's aliases belong only to their own resolved target.
			if (!resolvedTargets.some((candidate) => sameLexicalPath(candidate, resolved))) continue;
			if (!add(resolved, resolved)) return { action: "ask", rules: [] };
			const pending = new Set([value]);
			for (const spelling of pending) {
				if (!add(spelling, resolved)) return { action: "ask", rules: [] };
				if (!isAbsolute(spelling)) continue;
				const { root } = parse(spelling);
				const parts = spelling.slice(root.length).split(sep).filter(Boolean);
				for (let index = 0; index < parts.length; index++) {
					// Do not normalize "..": a preceding symlink changes what its parent means.
					const candidate = root + parts.slice(0, index + 1).join(sep);
					let link: string;
					try {
						if (!lstatSync(candidate).isSymbolicLink()) continue;
						if (++hops > 40) return { action: "ask", rules: [] };
						link = readlinkSync(candidate);
					} catch (error) {
						if (
							error instanceof Error &&
							"code" in error &&
							(error.code === "ENOENT" || error.code === "ENOTDIR")
						)
							break;
						throw error;
					}
					const parent = root + parts.slice(0, index).join(sep);
					const followed = isAbsolute(link) ? link : `${parent}${parent.endsWith(sep) ? "" : sep}${link}`;
					const tail = parts.slice(index + 1);
					const next = tail.length ? `${followed}${followed.endsWith(sep) ? "" : sep}${tail.join(sep)}` : followed;
					if (!add(next, resolved)) return { action: "ask", rules: [] };
					pending.add(next);
				}
			}
		}
	} catch (error) {
		// Missing tails are supported by the strict resolver; loops, hop exhaustion and
		// unavailable metadata cannot establish the complete spelling set.
		if (error instanceof Error && "code" in error) return { action: "ask", rules: [] };
		throw error;
	}
	let action: Rule["action"] = "allow";
	const rules: Rule[] = [];
	for (const [spelling, resolved] of spellings) {
		const decision = decide(spelling, resolved, canonicalCase);
		if (decision.action === "deny" || (decision.action === "ask" && action === "allow")) action = decision.action;
		rules.push(...decision.rules);
	}
	return { action, rules };
}
