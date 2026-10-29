import { spawn } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = join(import.meta.dirname, "../fixtures/private-fd-hop.ts");

async function exchange(mode: string, table = '{"sample-channel":5}') {
	const child = spawn(process.execPath, [fixture, mode], {
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			SENPI_PRIVATE_FDS: table,
			PI_OFFLINE: "1",
		},
		stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
	});
	const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
	const stdio: readonly unknown[] = child.stdio;
	const channel = stdio[5];
	if (!(channel instanceof Socket)) throw new Error("fixture did not receive a duplex");
	let received = "";
	let stderr = "";
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	channel.on("data", (chunk: Buffer) => {
		received += chunk.toString();
		if (received === "claimed:ping" || received === "engine-claimed") channel.end();
	});
	channel.on("error", () => channel.destroy());
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	channel.write("ping");
	try {
		const [code] = await closed;
		return { code, received, stderr, stdout };
	} finally {
		channel.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

function reports(stderr: string): unknown[] {
	return stderr
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line): unknown => JSON.parse(line));
}

// #4749: actual inherited sockets cross the production supervisor spawn, not a mocked spawn table.
describe("private host descriptors", () => {
	it.skipIf(process.platform === "win32")("forwards the named duplex into the engine", async () => {
		// given a launcher-created duplex, when the supervisor starts its engine
		const result = await exchange("supervisor");
		// then the engine can reply through that same private channel
		expect(result, result.stderr).toMatchObject({ code: 0, received: "engine:ping" });
	});

	it("never forwards a private channel into an unrelated child", async () => {
		// given the same bootstrap, when an ordinary child is spawned
		const result = await exchange("unrelated");
		// then both descriptor authority and the environment selector are absent
		expect(JSON.parse(result.received)).toEqual({ childExit: 2, leakedTable: false });
	});

	const state = (fields: { available?: boolean; declared?: boolean; present?: boolean; unparseable?: boolean }) => ({
		available: false,
		repeated: false,
		declared: false,
		present: true,
		unparseable: false,
		...fields,
	});
	const engine = (fields: { available?: boolean; declared?: boolean; present?: boolean; unparseable?: boolean }) => ({
		mode: "engine-report",
		present: true,
		declared: true,
		unparseable: false,
		available: false,
		...fields,
	});
	const nested = { mode: "nested", present: false, declared: false, unparseable: false, available: false };

	it.skipIf(process.platform === "win32")("claims the named channel only once", async () => {
		const result = await exchange("receiver");
		expect(JSON.parse(result.stdout)).toEqual(state({ available: true, declared: true }));
		expect(result.received).toBe("claimed:ping");
	});

	it("declares a null entry without adopting any descriptor", async () => {
		// given a desktop host that declares the channel on a path with no descriptor
		const result = await exchange("receiver", '{"sample-channel":null}');
		// then the name is declared, and the open fd 5 is not adopted
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.each([
		['{"sample-channel":4}', "a reserved descriptor"],
		['{"sample-channel":5,"alias":5}', "a descriptor named twice"],
		['{"sample-channel":65}', "a descriptor above the range"],
		['{"sample-channel":6}', "a descriptor that is not open"],
		['{"sample-channel":"5"}', "a string"],
		['{"sample-channel":true}', "a boolean"],
	])("keeps the name declared but unavailable for %s (%s)", async (table) => {
		const result = await exchange("receiver", table);
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.each([
		["", state({ present: false })],
		['{"bad name":5}', state({})],
		["not-json", state({ unparseable: true })],
		["[5]", state({ unparseable: true })],
	])("never declares the channel for table %j", async (table, expected) => {
		const result = await exchange("receiver", table);
		expect(JSON.parse(result.stdout)).toEqual(expected);
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")(
		"canary: an invalid entry beside the channel leaves the channel working",
		async () => {
			const result = await exchange("receiver", '{"sample-channel":5,"other":{},"bad name":7}');
			expect(JSON.parse(result.stdout)).toEqual(state({ available: true, declared: true }));
			expect(result.received).toBe("claimed:ping");
		},
	);

	it("canary: a garbage table declares the names it still quotes, all unavailable", async () => {
		const result = await exchange("receiver", '{"sample-channel":5');
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")("forwards a null declaration hop to hop into the engine", async () => {
		// given a null entry, when the supervisor starts its engine
		const result = await exchange("supervisor-report", '{"sample-channel":null}');
		// then the engine sees the declaration without a channel, and its nested host sees neither
		expect(result.code, result.stderr).toBe(0);
		expect(reports(result.stderr)).toEqual([nested, engine({})]);
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")(
		"carries an unparseable table to the engine as present but unavailable",
		async () => {
			const result = await exchange("supervisor-report", "%%%");
			expect(result.code, result.stderr).toBe(0);
			expect(reports(result.stderr)).toEqual([nested, engine({ declared: false, unparseable: true })]);
			expect(result.received).toBe("");
		},
	);

	it.skipIf(process.platform === "win32")("ends the chain at the engine: a nested host inherits nothing", async () => {
		// given the engine received the named duplex
		const result = await exchange("supervisor-report");
		// then a host it starts before claiming gets neither the table nor the descriptor; the engine still claims it
		expect(result.code, result.stderr).toBe(0);
		expect(reports(result.stderr)).toEqual([nested, engine({ available: true })]);
		expect(result.received).toBe("engine-claimed");
	});

	it.runIf(process.platform === "win32")("does not forward unsupported Windows descriptors", async () => {
		// given a Windows launcher, when it attempts the POSIX descriptor path
		const result = await exchange("supervisor");
		// then no stream reaches the engine
		expect(result.received).toBe("");
		expect(result.code).not.toBe(0);
	});
});
