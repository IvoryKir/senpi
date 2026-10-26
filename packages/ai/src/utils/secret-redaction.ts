// Credential redaction for provider and gateway text, read token by token in one pass (senpi#4283).
//
// The text is read ONCE, left to right, as alternating runs: a token (value characters) and a delimiter (everything
// between two tokens). A token is classified only from its own characters and the delimiters on either side of it;
// nothing inside the loop searches, slices from the start or re-reads earlier text, so the work is linear in the
// input whatever its shape. The scanner uses no regular expressions. A replaced range is a whole token (plus the
// base64 padding after it), except a URL userinfo password, which runs from its ":" to the "@".

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

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;
const isAlnum = (c: number): boolean => isDigit(c) || isUpper(c) || isLower(c);
const isBase64Url = (c: number): boolean => isAlnum(c) || c === 95 || c === 45;
const isUpperOrDigit = (c: number): boolean => isDigit(c) || isUpper(c);
const isSlackChar = (c: number): boolean => isAlnum(c) || c === 45;
const isPatChar = (c: number): boolean => isAlnum(c) || c === 95;
const isNameChar = (c: number): boolean => isBase64Url(c) || c === 46;
const isTokenChar = (c: number): boolean => isNameChar(c) || c === 43 || c === 47 || c === 126;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isQuote = (c: number): boolean => c === 34 || c === 39 || c === 96 || c === 92;

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

function matchesAt(text: string, i: number, literal: string, limit = text.length): boolean {
	if (i + literal.length > limit) return false;
	for (let k = 0; k < literal.length; k++) if (text.charCodeAt(i + k) !== literal.charCodeAt(k)) return false;
	return true;
}

/** The length of the token unit at i (a value character, or a percent escape of one), or 0 at a delimiter. */
function tokenUnitLength(text: string, i: number): number {
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
	if (c === 37) return (percentDecoded(text, i) << 3) | 3;
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

interface Delimiter {
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
}

function emptyDelimiter(): Delimiter {
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
	};
}

/** Read the delimiter that starts at i into d, one unit at a time. */
function readDelimiter(text: string, i: number, d: Delimiter): void {
	let position = i;
	let units = 0;
	let separators = 0;
	let separatorShape = true;
	let gapMarks = 0;
	let gapShape = true;
	let padding = true;
	let spaces = 0;
	let last = -1;
	let first = -1;
	let tagShape = true;
	d.opensObject = false;
	d.braceDepth = 0;
	d.paddingEnd = i;
	d.at = -1;
	d.endsUserinfo = false;
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

/** The last component of a credential name, after digits and qualifiers are stripped (see secretWord). */
const SECRET_WORDS = new Set([
	"key",
	"apikey",
	"accesskey",
	"secretkey",
	"privatekey",
	"token",
	"accesstoken",
	"refreshtoken",
	"authtoken",
	"apitoken",
	"idtoken",
	"secret",
	"clientsecret",
	"auth",
	"authorization",
	"bearer",
	"cookie",
	"cookies",
	"password",
	"passwd",
	"pwd",
	"passphrase",
	"credential",
	"credentials",
	"signature",
	"sig",
]);
/** Names whose value is a credential at any length; every other credential name needs a 16-character value. */
const STRICT_WORDS = new Set([
	"password",
	"passwd",
	"pwd",
	"passphrase",
	"secret",
	"clientsecret",
	"authorization",
	"bearer",
]);
const COOKIE_WORDS = new Set(["cookie", "cookies"]);
/** A trailing component that names a part of the credential the name before it holds: api_key_value, apiKeyId. */
const QUALIFIERS = new Set(["value", "val", "id"]);
const SCHEMES = new Set(["bearer", "basic", "token", "apikey"]);
/** Values that are never credentials, including a replacement an earlier pass wrote (redaction is idempotent). */
const INERT_VALUES = new Set(["redacted", "null", "true", "false", "none", "undefined"]);
const COOKIE_ATTRIBUTES = new Set([
	"path",
	"domain",
	"expires",
	"max-age",
	"samesite",
	"secure",
	"httponly",
	"priority",
	"partitioned",
]);
/** Split a name into lowercase components on "_", "-", "." and camelCase, reading only the name's own characters. */
function nameComponents(text: string, start: number, end: number): string[] {
	const parts: string[] = [];
	let current = "";
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i);
		if (c === 95 || c === 45 || c === 46) {
			if (current.length > 0) parts.push(current);
			current = "";
			continue;
		}
		if (isUpper(c) && current.length > 0) {
			const previous = text.charCodeAt(i - 1);
			const next = i + 1 < end ? text.charCodeAt(i + 1) : 0;
			if (isLower(previous) || isDigit(previous) || (isUpper(previous) && isLower(next))) {
				parts.push(current);
				current = "";
			}
		}
		current += String.fromCharCode(isUpper(c) ? c + 32 : c);
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

function isAllDigits(part: string): boolean {
	for (let k = 0; k < part.length; k++) if (!isDigit(part.charCodeAt(k))) return false;
	return true;
}

function withoutTrailingDigits(part: string): string {
	let end = part.length;
	while (end > 1 && isDigit(part.charCodeAt(end - 1))) end--;
	return part.slice(0, end);
}

/**
 * The credential word a name ends with, after its normalization: numbered slots (OPENAI_API_KEY_2, token2,
 * x-api-key-1) and a trailing qualifier (api_key_value, apiKeyId) still end with the word. "session" counts only as
 * the whole name, so session_id stays readable; a word elsewhere in a name (token_type, primary_key_column) or inside
 * a word (monkey, tokenizer, max_tokens) does not count.
 */
function secretWord(text: string, start: number, end: number): string | undefined {
	const parts = nameComponents(text, start, end);
	if (parts.length === 1 && parts[0] === "session") return "session";
	let last = parts.length - 1;
	for (;;) {
		while (last >= 0 && isAllDigits(parts[last] ?? "")) last--;
		if (last > 0 && QUALIFIERS.has(parts[last] ?? "")) last--;
		else break;
	}
	if (last < 0) return undefined;
	const word = withoutTrailingDigits(parts[last] ?? "");
	return SECRET_WORDS.has(word) ? word : undefined;
}

/** Where the name ends a token: its last run of name characters (a URL path or escape before it is not the name). */
function nameStart(text: string, start: number, end: number): number {
	let i = end;
	while (i > start && isNameChar(text.charCodeAt(i - 1))) i--;
	return i;
}

function lowerToken(text: string, start: number, end: number, maxLength: number): string | undefined {
	return end - start > maxLength ? undefined : text.slice(start, end).toLowerCase();
}

function isInert(text: string, start: number, end: number): boolean {
	const word = lowerToken(text, start, end, 9);
	return word !== undefined && INERT_VALUES.has(word);
}

interface PrefixRule {
	readonly prefixes: readonly string[];
	readonly min: number;
	readonly chars: (c: number) => boolean;
	/** The run after the prefix is exactly min characters long (AWS access key ids). */
	readonly exact?: boolean;
}

/** Credential-shaped tokens recognized by their prefix wherever they appear. */
const PREFIX_RULES: readonly PrefixRule[] = [
	{ prefixes: ["sk-"], min: 8, chars: isBase64Url },
	{ prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"], min: 16, chars: isAlnum },
	{ prefixes: ["gsk_", "xai-", "hf_"], min: 20, chars: isAlnum },
	{ prefixes: ["xoxa-", "xoxb-", "xoxo-", "xoxp-", "xoxr-", "xoxs-"], min: 10, chars: isSlackChar },
	{ prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], min: 20, chars: isAlnum },
	{ prefixes: ["github_pat_"], min: 20, chars: isPatChar },
	{ prefixes: ["AKIA", "ASIA"], min: 16, chars: isUpperOrDigit, exact: true },
	{ prefixes: ["AIza"], min: 30, chars: isBase64Url },
];

function matchesPrefixRule(text: string, start: number, end: number, rule: PrefixRule): boolean {
	for (const prefix of rule.prefixes) {
		if (!matchesAt(text, start, prefix, end)) continue;
		let run = 0;
		const limit = rule.exact === true ? rule.min + 1 : rule.min;
		for (let i = start + prefix.length; i < end && run < limit && rule.chars(text.charCodeAt(i)); i++) run++;
		return rule.exact === true ? run === rule.min : run >= rule.min;
	}
	return false;
}

/** A JWT: exactly three base64url segments joined by ".", the first a JSON header ("eyJ"), decided in one pass. */
function isJwt(text: string, start: number, end: number): boolean {
	if (!matchesAt(text, start, "eyJ", end)) return false;
	let segments = 1;
	let length = 0;
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i);
		if (c === 46) {
			if (length < (segments === 1 ? 8 : 5) || segments === 3) return false;
			segments++;
			length = 0;
		} else if (isBase64Url(c)) length++;
		else return false;
	}
	return segments === 3 && length >= 5;
}

function isCredentialShape(text: string, start: number, end: number): boolean {
	let stop = end;
	while (stop > start && text.charCodeAt(stop - 1) === 46) stop--;
	for (const rule of PREFIX_RULES) if (matchesPrefixRule(text, start, stop, rule)) return true;
	return isJwt(text, start, stop);
}

const MIN_SECRET_LENGTH = 16;
const MIN_BEARER_LENGTH = 8;
const OBJECT_SPAN = 4096;
const MAX_COOKIE_PAIRS = 64;
const MAX_USERINFO_LENGTH = 256;

/** Append [start, end) to the sorted, disjoint ranges, merging what it overlaps. */
function addRange(ranges: number[], start: number, end: number): void {
	let stop = end;
	while (ranges.length > 0 && (ranges[ranges.length - 2] ?? 0) >= start) {
		stop = Math.max(stop, ranges[ranges.length - 1] ?? 0);
		ranges.length -= 2;
	}
	if (ranges.length > 0 && (ranges[ranges.length - 1] ?? 0) >= start) {
		ranges[ranges.length - 1] = Math.max(ranges[ranges.length - 1] ?? 0, stop);
	} else ranges.push(start, stop);
}

type Mode = "none" | "scheme" | "value" | "cookie" | "cookie-value" | "object";

/** The [start, end) ranges of every credential in text, found in one left-to-right pass. */
function secretRanges(text: string): number[] {
	const ranges: number[] = [];
	let before = emptyDelimiter();
	let after = emptyDelimiter();
	readDelimiter(text, 0, before);
	let i = before.end;
	let mode: Mode = "none";
	let strict = false;
	let cookiePairs = 0;
	let cookieAttribute = false;
	let objectDepth = 0;
	let objectEnd = 0;
	let bearerArmed = false;
	let userinfoStart = -1;
	while (i < text.length) {
		const start = i;
		let slashes = 0;
		while (i < text.length) {
			const length = tokenUnitLength(text, i);
			if (length === 0) break;
			if (text.charCodeAt(i) === 47) slashes++;
			i += length;
		}
		const end = i;
		readDelimiter(text, end, after);
		i = after.end;
		const valueEnd = after.paddingEnd;
		const valueLength = valueEnd - start;

		if (userinfoStart >= 0) {
			if (slashes > 0 || end - userinfoStart > MAX_USERINFO_LENGTH) userinfoStart = -1;
			else if (after.at >= 0) {
				if (after.at > userinfoStart) addRange(ranges, userinfoStart, after.at);
				userinfoStart = -1;
			} else if (after.endsUserinfo) userinfoStart = -1;
		}
		const authority = slashes === 2 && matchesAt(text, start, "//", end);
		if (authority && before.colonOnly && after.colonOnly) userinfoStart = after.end;

		if (isCredentialShape(text, start, end)) addRange(ranges, start, end);
		if (bearerArmed && valueLength >= MIN_BEARER_LENGTH && !isInert(text, start, end)) {
			addRange(ranges, start, valueEnd);
		}
		bearerArmed = after.spaceOnly && lowerToken(text, start, end, 6) === "bearer";

		const idle = mode === "none";
		if (mode === "scheme" && SCHEMES.has(lowerToken(text, start, end, 6) ?? "")) {
			// An auth scheme is never the value itself: the token after it is, or there is none ("Bearer [REDACTED]").
			mode = after.spaceOnly ? "value" : "none";
		} else if (mode === "scheme" || mode === "value") {
			if (valueLength >= (strict ? 1 : MIN_SECRET_LENGTH) && !isInert(text, start, end)) {
				addRange(ranges, start, valueEnd);
			}
			mode = "none";
		} else if (mode === "cookie") {
			if (after.pairEquals) {
				cookieAttribute = COOKIE_ATTRIBUTES.has(lowerToken(text, start, end, 11) ?? "");
				mode = "cookie-value";
			} else {
				if (valueLength >= MIN_SECRET_LENGTH && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
				mode = after.cookieGap && ++cookiePairs < MAX_COOKIE_PAIRS ? "cookie" : "none";
			}
		} else if (mode === "cookie-value") {
			if (!cookieAttribute && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
			mode = after.cookieGap && ++cookiePairs < MAX_COOKIE_PAIRS ? "cookie" : "none";
		} else if (mode === "object") {
			const value = before.separator && !before.opensObject;
			if (value && valueLength >= MIN_SECRET_LENGTH && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
			objectDepth += after.braceDepth;
			if (objectDepth <= 0 || end > objectEnd) mode = "none";
		}

		if (idle && (after.separator || (before.endsWithLt && after.closesTag))) {
			const word = secretWord(text, nameStart(text, start, end), end);
			if (word !== undefined && COOKIE_WORDS.has(word)) {
				mode = "cookie";
				cookiePairs = 0;
			} else if (word !== undefined && after.opensObject) {
				mode = "object";
				objectDepth = after.braceDepth;
				objectEnd = end + OBJECT_SPAN;
			} else if (word !== undefined) {
				mode = "scheme";
				strict = STRICT_WORDS.has(word);
			}
		}
		const previous = before;
		before = after;
		after = previous;
	}
	return ranges;
}

function replaceRanges(text: string, ranges: readonly number[], replacement: string): string {
	if (ranges.length === 0) return text;
	const out: string[] = [];
	let copied = 0;
	for (let k = 0; k < ranges.length; k += 2) {
		out.push(text.slice(copied, ranges[k]), replacement);
		copied = ranges[k + 1] ?? copied;
	}
	out.push(text.slice(copied));
	return out.join("");
}

/**
 * Mask credentials in provider or gateway text by value, not by a list of names: the value after a name that ends
 * with a credential word (in a header, JSON, array, Go map, Python repr, XML, URL query, form body, cookie or
 * environment assignment, with ASCII, typographic or HTML-escaped quotes, at any escaping depth; 16 characters or
 * more, or any length under a password, secret, authorization or bearer name), every cookie value, every
 * long value of an object held under such a name, URL userinfo passwords, bearer tokens, known key prefixes and JWTs
 * anywhere. Model ids, error codes, request ids and names that merely contain a credential word stay readable.
 * One linear pass, no regular expressions.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	return replaceRanges(text, secretRanges(text), replacement);
}

/** Mask only credential-shaped tokens (known key prefixes and JWTs), whatever surrounds them. One linear pass. */
export function redactCredentialShapes(text: string, replacement = "[REDACTED]"): string {
	const ranges: number[] = [];
	let i = 0;
	while (i < text.length) {
		const start = i;
		for (let length = tokenUnitLength(text, i); length > 0; length = tokenUnitLength(text, i)) i += length;
		if (i > start && isCredentialShape(text, start, i)) ranges.push(start, i);
		if (i === start) i++;
	}
	return replaceRanges(text, ranges, replacement);
}
