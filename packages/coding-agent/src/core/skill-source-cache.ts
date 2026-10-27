import type { Stats } from "node:fs";
import { readSkillMarkdownSource } from "./skill-discovery.ts";

const MAX_CACHED_SKILL_SOURCES = 4096;
/**
 * Coarse filesystem clocks (Linux jiffies, FAT's 2 s) can give a same-size rewrite the same stamp as
 * the read before it. As git does for racy index entries, a read is reused only when the file was last
 * written well before that read, so no later write can share its stamp.
 */
const RACY_WRITE_WINDOW_MS = 3000;

interface CachedSkillSource {
	readonly stamp: string;
	readonly source: string;
}

/**
 * Process-wide: a shared RPC host opens a fresh resource loader for every session, and each open
 * loaded every user skill twice (omo#11437). The stat the caller already took is the validator, so an
 * edited, replaced, or touched SKILL.md is read again on the next load and hot reload is unchanged.
 * Project skills never come here; their checked descriptor read stays per load.
 */
const cachedSources = new Map<string, CachedSkillSource>();

function statStamp(stats: Stats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

/** `readSkillMarkdownSource` for a user skill file, reusing the last read while `stats` still matches it. */
export function readUserSkillSource(filePath: string, stats: Stats): string {
	const stamp = statStamp(stats);
	const cached = cachedSources.get(filePath);
	if (cached?.stamp === stamp) return cached.source;
	const source = readSkillMarkdownSource(filePath);
	cachedSources.delete(filePath);
	if (stats.mtimeMs > Date.now() - RACY_WRITE_WINDOW_MS) return source;
	cachedSources.set(filePath, { stamp, source });
	if (cachedSources.size > MAX_CACHED_SKILL_SOURCES) {
		const oldest = cachedSources.keys().next();
		if (!oldest.done) cachedSources.delete(oldest.value);
	}
	return source;
}
