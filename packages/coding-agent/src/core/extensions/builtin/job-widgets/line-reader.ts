/**
 * Reads one source between refreshes into complete, clean lines.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobTextSource } from "./source-types.ts";

/** Longest line kept; longer lines are cut. */
export const MAX_LINE_CHARS = 4096;

const ANSI_SEQUENCE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** A line without terminal escape sequences and control characters (tabs stay). */
function sanitizeLine(line: string): string {
	return line.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

export interface SourceLines {
	lines: string[];
	open: boolean;
	/** Offset just past the read text (the source's size so far). */
	end: number;
}

/**
 * Keeps a cursor, carries the trailing partial line to the next read, turns CR and CRLF into line
 * breaks, strips ANSI and control characters, and cuts lines at {@link MAX_LINE_CHARS}. When the
 * source dropped text the reader never saw, the torn line at the gap is skipped so no rule reads
 * half a line.
 */
export class SourceLineReader {
	readonly source: JobTextSource;
	#cursor = 0;
	/** Raw text of the line in progress; sanitized once complete so split escapes still strip. */
	#partial = "";
	#torn = false;

	constructor(source: JobTextSource) {
		this.source = source;
	}

	/** New complete lines; `flush` also ends the line in progress. */
	read(flush: boolean): SourceLines {
		const chunk = this.source.read(this.#cursor);
		let text = chunk.text;
		if (chunk.start > this.#cursor) {
			this.#partial = "";
			this.#torn = true;
		}
		this.#cursor = Math.max(this.#cursor, chunk.end);
		if (this.#torn) {
			const lineEnd = text.search(/[\r\n]/);
			if (lineEnd === -1) text = "";
			else {
				text = text.slice(lineEnd + 1);
				this.#torn = false;
			}
		}
		const raw = (this.#partial + text).replace(/\r\n?/g, "\n").split("\n");
		this.#partial = (raw.pop() ?? "").slice(0, MAX_LINE_CHARS * 2);
		if ((flush || !chunk.open) && this.#partial.length > 0) {
			raw.push(this.#partial);
			this.#partial = "";
		}
		const lines = raw.map((line) => sanitizeLine(line).slice(0, MAX_LINE_CHARS));
		return { lines, open: chunk.open, end: chunk.end };
	}
}
