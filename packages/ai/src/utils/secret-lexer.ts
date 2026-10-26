// The lexical layer of the credential redactor (senpi#4283): character classes, percent escapes and HTML entities read
// as what they encode, the token and delimiter units the one-pass scanner alternates between, and the forward scans
// that find where a quoted or bare value ends. Every function reads forward from the index it is given; none searches
// back or uses a regular expression.

const HTML_ENTITIES: readonly (readonly [entity: string, character: number])[] = [
	["&quot;", 34],
	["&#34;", 34],
	["&#034;", 34],
	["&#x22;", 34],
	["&#39;", 39],
	["&#039;", 39],
	["&#x27;", 39],
	["&lt;", 60],
	["&gt;", 62],
	["&amp;", 38],
];

const MAX_SEPARATOR_LENGTH = 32;
const MAX_SCHEME_GAP = 8;

export const isDigit = (c: number): boolean => c >= 48 && c <= 57;
export const isUpper = (c: number): boolean => c >= 65 && c <= 90;
export const isLower = (c: number): boolean => c >= 97 && c <= 122;
export const isAlnum = (c: number): boolean => isDigit(c) || isUpper(c) || isLower(c);
export const isBase64Url = (c: number): boolean => isAlnum(c) || c === 95 || c === 45;
export const isNameChar = (c: number): boolean => isBase64Url(c) || c === 46;
const isTokenChar = (c: number): boolean => isNameChar(c) || c === 43 || c === 47 || c === 126;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isQuote = (c: number): boolean => c === 34 || c === 39 || c === 96 || c === 92;
const isOpeningQuote = (c: number): boolean => c === 34 || c === 39 || c === 96;
const isTypographicQuote = (c: number): boolean => c === 0x201c || c === 0x201d || c === 0x2018 || c === 0x2019;

function hexValue(c: number): number {
	if (isDigit(c)) return c - 48;
	if (c >= 65 && c <= 70) return c - 55;
	if (c >= 97 && c <= 102) return c - 87;
	return -1;
}

function percentDecoded(text: string, i: number): number {
	if (i + 2 >= text.length) return -1;
	const high = hexValue(text.charCodeAt(i + 1));
	const low = hexValue(text.charCodeAt(i + 2));
	return high < 0 || low < 0 ? -1 : high * 16 + low;
}

/** Whether the three-character percent unit at i is token punctuation that starts a new word. */
export function isEncodedWordBoundary(text: string, i: number): boolean {
	if (text.charCodeAt(i) !== 37) return false;
	const decoded = percentDecoded(text, i);
	return decoded === 47 || decoded === 43 || decoded === 126 || decoded === 45 || decoded === 46;
}

export function matchesAt(text: string, i: number, literal: string, limit = text.length): boolean {
	if (i + literal.length > limit) return false;
	for (let k = 0; k < literal.length; k++) if (text.charCodeAt(i + k) !== literal.charCodeAt(k)) return false;
	return true;
}

/** The length of the token unit at i (a value character, or a percent escape of one), or 0 at a delimiter. */
export function tokenUnitLength(text: string, i: number): number {
	const c = text.charCodeAt(i);
	if (isTokenChar(c)) return 1;
	if (c !== 37) return 0;
	const decoded = percentDecoded(text, i);
	if (decoded < 0) return 1;
	return isTokenChar(decoded) ? 3 : 0;
}

/** The delimiter unit at i, packed as (logical character << 3) | length: escapes and entities read as what they encode. */
function delimiterUnit(text: string, i: number): number {
	const c = text.charCodeAt(i);
	if (c === 37) {
		const decoded = percentDecoded(text, i);
		return decoded < 0 ? (c << 3) | 1 : (decoded << 3) | 3;
	}
	if (c === 38) {
		for (const [entity, character] of HTML_ENTITIES) {
			if (matchesAt(text, i, entity)) return (character << 3) | entity.length;
		}
	}
	if (c === 0xff1a) return (58 << 3) | 1;
	if (c === 0x201c || c === 0x201d) return (34 << 3) | 1;
	if (c === 0x2018 || c === 0x2019) return (39 << 3) | 1;
	return (c << 3) | 1;
}

export interface Delimiter {
	end: number;
	/** One ":" or "=" between quotes, escapes and spaces, then an optional "[" or "{". */
	separator: boolean;
	opensObject: boolean;
	braceDepth: number;
	/** The end of the "=" padding it starts with, which belongs to the token before it. */
	paddingEnd: number;
	pairEquals: boolean;
	cookieGap: boolean;
	spaceOnly: boolean;
	endsWithLt: boolean;
	closesTag: boolean;
	colonOnly: boolean;
	at: number;
	endsUserinfo: boolean;
	/** The quote character the delimiter ends with (it opens the value after it), or -1. */
	quote: number;
	/** How many backslashes escape that quote: the escaping depth its closing quote is written at. */
	quoteBackslashes: number;
}

export function emptyDelimiter(): Delimiter {
	return {
		end: 0,
		separator: false,
		opensObject: false,
		braceDepth: 0,
		paddingEnd: 0,
		pairEquals: false,
		cookieGap: false,
		spaceOnly: false,
		endsWithLt: false,
		closesTag: false,
		colonOnly: false,
		at: -1,
		endsUserinfo: false,
		quote: -1,
		quoteBackslashes: 0,
	};
}

/** Read the delimiter that starts at i into d, one unit at a time. */
export function readDelimiter(text: string, i: number, d: Delimiter): void {
	let position = i;
	let units = 0;
	let separators = 0;
	let separatorShape = true;
	let gapMarks = 0;
	let gapShape = true;
	let padding = true;
	let spaces = 0;
	let backslashes = 0;
	let last = -1;
	let first = -1;
	let tagShape = true;
	d.opensObject = false;
	d.braceDepth = 0;
	d.paddingEnd = i;
	d.at = -1;
	d.endsUserinfo = false;
	d.quote = -1;
	d.quoteBackslashes = 0;
	while (position < text.length && tokenUnitLength(text, position) === 0) {
		const unit = delimiterUnit(text, position);
		const c = unit >> 3;
		if (units === 0) first = c;
		else if (!isSpace(c)) tagShape = false;
		if (padding && c === 61) d.paddingEnd = position + (unit & 7);
		else {
			padding = false;
			if (c === 59 || c === 44) gapMarks++;
			else if (!isSpace(c) && !isQuote(c)) gapShape = false;
		}
		if (c === 58 || c === 61) separators++;
		else if (c === 123) {
			d.braceDepth++;
			if (separators === 1) d.opensObject = true;
			else separatorShape = false;
		} else if (c === 125) {
			d.braceDepth--;
			separatorShape = false;
		} else if (!isSpace(c) && !isQuote(c) && !(c === 91 && separators === 1)) separatorShape = false;
		if (isSpace(c)) spaces++;
		if (c === 64 && d.at < 0) d.at = position;
		if (isSpace(c) || c === 63 || c === 35) d.endsUserinfo = true;
		d.quote = isOpeningQuote(c) ? c : -1;
		d.quoteBackslashes = backslashes;
		backslashes = c === 92 ? backslashes + 1 : 0;
		last = c;
		units++;
		position += unit & 7;
	}
	const length = position - i;
	d.end = position;
	d.separator = separators === 1 && separatorShape && length <= MAX_SEPARATOR_LENGTH;
	d.pairEquals = units === 1 && first === 61;
	d.cookieGap = gapMarks === 1 && gapShape && length <= MAX_SEPARATOR_LENGTH;
	d.spaceOnly = units > 0 && spaces === units && units <= MAX_SCHEME_GAP;
	d.endsWithLt = last === 60;
	d.closesTag = first === 62 && tagShape;
	d.colonOnly = units === 1 && first === 58;
}

/**
 * Where a quoted value that continues at i ends: its closing quote, written at the opening quote's escaping depth (a
 * quote behind more backslashes is escaped inside the value), or the end of the line.
 */
export function quotedValueEnd(text: string, i: number, quote: number, depth: number): number {
	let position = i;
	let backslashes = 0;
	while (position < text.length) {
		const raw = text.charCodeAt(position);
		if (raw === 10 || raw === 13) return position;
		if (raw === 92) {
			backslashes++;
			position++;
			continue;
		}
		const unit = delimiterUnit(text, position);
		if (unit >> 3 === quote && backslashes <= depth) return position - backslashes;
		backslashes = 0;
		position += unit & 7;
	}
	return position;
}

/** Where a bare value that continues at i ends: whitespace, ",", ";", "&", a quote or "<" (a closing tag). */
export function bareValueEnd(text: string, i: number): number {
	let position = i;
	for (; position < text.length; position++) {
		const c = text.charCodeAt(position);
		if (isSpace(c) || isQuote(c) || isTypographicQuote(c) || c === 44 || c === 59 || c === 38 || c === 60) break;
	}
	return position;
}
