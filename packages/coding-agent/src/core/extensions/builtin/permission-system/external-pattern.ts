import { type BigIntStats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { Wildcard } from "./wildcard.ts";

/**
 * Match the literal prefix by filesystem identity, then the remaining glob verbatim.
 * This also covers remembered scopes and missing descendants without folding case or opening
 * directories. A case-sensitive filesystem gives distinct prefixes distinct device/inode pairs.
 */
export function matchesExternalPath(value: string, pattern: string): boolean {
	if (!isAbsolute(value) || !isAbsolute(pattern)) return false;
	const wildcard = pattern.search(/[*?]/);
	const boundary =
		wildcard < 0 ? pattern.length : Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf(sep, wildcard));
	let prefix = wildcard < 0 ? pattern : pattern.slice(0, boundary + 1);
	const suffix = wildcard < 0 ? [] : [pattern.slice(boundary + 1)];
	prefix = realpathWithoutOpen(prefix);
	let identity: BigIntStats;
	for (;;) {
		try {
			identity = statSync(prefix, { bigint: true });
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
			const parent = dirname(prefix);
			if (parent === prefix) return false;
			suffix.unshift(basename(prefix));
			prefix = parent;
		}
	}

	let ancestor = realpathWithoutOpen(value);
	const tail: string[] = [];
	for (;;) {
		try {
			const candidate = statSync(ancestor, { bigint: true });
			if (candidate.dev === identity.dev && candidate.ino === identity.ino) {
				if (tail.length === 0 && suffix.length > 0) return false;
				return Wildcard.match(tail.join("/"), suffix.join("/").split(sep).join("/"));
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		tail.unshift(basename(ancestor));
		ancestor = parent;
	}
}
