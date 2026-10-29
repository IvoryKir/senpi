import { fstatSync } from "node:fs";
import type { Duplex } from "node:stream";
import { inheritedDuplex } from "./utils/inherited-duplex.ts";

const TABLE_ENV = "SENPI_PRIVATE_FDS";
/** Set only on the supervisor-to-engine hop: the engine claims its channels and never forwards them. */
export const PRIVATE_FDS_FINAL_ENV = "SENPI_PRIVATE_FDS_FINAL";
const STATE = Symbol.for("senpi.private-fds.v2");
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** A name maps to a descriptor, or to null when the launcher declared it without one on this path. */
export type PrivateFdEntry = number | null;

interface PrivateFdState {
	readonly declared: ReadonlySet<string>;
	readonly channels: Map<string, number>;
	readonly forward: Map<string, PrivateFdEntry>;
}

function isState(value: unknown): value is PrivateFdState {
	return (
		typeof value === "object" &&
		value !== null &&
		"declared" in value &&
		value.declared instanceof Set &&
		"channels" in value &&
		value.channels instanceof Map &&
		"forward" in value &&
		value.forward instanceof Map
	);
}

function parseTable(encoded: string | undefined): Map<string, PrivateFdEntry> | undefined {
	if (!encoded || encoded.length > 4096) return undefined;
	const value: unknown = JSON.parse(encoded);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const table = new Map<string, PrivateFdEntry>();
	const descriptors = new Set<number>();
	for (const [name, fd] of Object.entries(value)) {
		if (!NAME.test(name)) return undefined;
		if (fd === null) {
			table.set(name, null);
			continue;
		}
		if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 5 || fd > 64 || descriptors.has(fd)) {
			return undefined;
		}
		descriptors.add(fd);
		table.set(name, fd);
	}
	return table;
}

/** Shared by the bundled CLI and the separately imported public subpath in the same isolate. */
function capturedState(): PrivateFdState {
	const previous: unknown = Reflect.get(globalThis, STATE);
	if (isState(previous)) return previous;
	const encoded = process.env[TABLE_ENV];
	const final = process.env[PRIVATE_FDS_FINAL_ENV] === "1";
	delete process.env[TABLE_ENV];
	delete process.env[PRIVATE_FDS_FINAL_ENV];
	const state: PrivateFdState = { declared: new Set(), channels: new Map(), forward: new Map() };
	Reflect.set(globalThis, STATE, state);
	try {
		const table = parseTable(encoded);
		if (table === undefined) return state;
		// Validate every descriptor before adopting any: a bad entry never becomes another fd.
		if (process.platform !== "win32") {
			for (const fd of table.values()) {
				if (fd === null) continue;
				const stat = fstatSync(fd);
				if (!stat.isSocket() && !stat.isFIFO()) return state;
			}
		}
		const fresh: PrivateFdState = { declared: new Set(table.keys()), channels: new Map(), forward: new Map() };
		for (const [name, fd] of table) {
			// Windows handle adoption is a separate implementation; a number there is only a declaration.
			const usable = fd !== null && process.platform !== "win32" ? fd : null;
			if (usable !== null) fresh.channels.set(name, usable);
			if (!final) fresh.forward.set(name, usable);
		}
		Reflect.set(globalThis, STATE, fresh);
		return fresh;
	} catch {
		// Untrusted startup metadata is optional authority; never echo its contents.
		return state;
	}
}

const state = capturedState();

/** True when the launcher declared this channel for the launch, with or without a descriptor. */
export function privateChannelDeclared(name: string): boolean {
	return state.declared.has(name);
}

/** Claim once. The caller owns disposal; Windows handle adoption has a separate implementation. */
export function takeInheritedPrivateChannel(name: string): Duplex | undefined {
	const fd = state.channels.get(name);
	if (fd === undefined) return undefined;
	state.channels.delete(name);
	if (state.forward.has(name)) state.forward.set(name, null);
	return inheritedDuplex(fd);
}

/** Only the intentional next engine hop may take the table and descriptor ownership from this process. */
export function takePrivateDescriptors(): ReadonlyMap<string, PrivateFdEntry> {
	const taken = new Map(state.forward);
	state.forward.clear();
	for (const [name, fd] of taken) if (fd !== null) state.channels.delete(name);
	return taken;
}
