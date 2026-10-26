import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, fstat: vi.fn(actual.fstat) };
});

let dir = "";
const managers: SessionManager[] = [];
beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-identity-"));
});
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

function create() {
	const manager = SessionManager.create(dir, dir);
	managers.push(manager);
	return manager;
}

function snapshot(manager: SessionManager) {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	return lane;
}

// #4347 / RULING-31(2): the first publication must name the descriptor we wrote, not a later pathname.
it("R31.2 replacement between create and first publish fails instead of adopting the replacement", async () => {
	const manager = create();
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	const file = String(manager.getSessionFile());
	fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
	fs.renameSync(`${file}.next`, file);
	await manager.persistHeaderNow();
	const lane = snapshot(manager);
	expect(readTranscriptRoot(lane.freeze().transcript)).toEqual({ ok: false, error: "base_file_replaced" });
});

it.each(["header", "atomic replacement"] as const)(
	"R31.2 %s captures its own descriptor even when the path changes before fstat",
	async (lifecycle) => {
		const manager = create();
		let id: string | undefined;
		if (lifecycle === "atomic replacement") {
			id = manager.appendMessage({ role: "user", content: "branch source", timestamp: 1 });
			await manager.persistHeaderNow();
		}
		const realStat = vi.mocked(fs.fstat).getMockImplementation();
		if (!realStat) throw new Error("real fstat implementation is installed");
		vi.mocked(fs.fstat).mockImplementationOnce((...args) => {
			const file = String(manager.getSessionFile());
			// Atomic replacement is still writing its temp fd: replacing the destination now would
			// precede its own rename. Replace immediately after the method returns instead.
			if (lifecycle === "header") {
				fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
				fs.renameSync(`${file}.next`, file);
			}
			return realStat(...args);
		});
		if (id) {
			const file = String(manager.createBranchedSession(id));
			fs.writeFileSync(`${file}.next`, fs.readFileSync(file));
			fs.renameSync(`${file}.next`, file);
		}
		await manager.persistHeaderNow();
		expect(readTranscriptRoot(snapshot(manager).freeze().transcript)).toEqual({
			ok: false,
			error: "base_file_replaced",
		});
	},
);

// #4347 / RULING-31(3): a captured descriptor never authorizes different history at the same inode.
it.each(["truncate", "rewrite"] as const)("R31.3 %s after capture is a typed failure", async (change) => {
	const manager = create();
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	await manager.persistHeaderNow();
	const lane = snapshot(manager);
	const held = lane.freeze();
	const file = String(manager.getSessionFile());
	if (change === "truncate") fs.truncateSync(file, 0);
	else {
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const entry = JSON.parse(lines[1] ?? "");
		lines[1] = JSON.stringify({ ...entry, id: `${entry.id}-rewritten` });
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
	}
	expect(readTranscriptRoot(held.transcript)).toEqual({
		ok: false,
		error: change === "truncate" ? "base_file_truncated" : "base_fingerprint_mismatch",
	});
});

// #4347 / RULING-31(4): same-turn snapshots cannot observe an asynchronous fstat result.
it("R31.4 snapshot before identity lands serves the bounded tail and then releases it", async () => {
	const manager = create();
	const stringify = vi.spyOn(JSON, "stringify");
	manager.appendMessage({ role: "user", content: "tail before identity", timestamp: 1 });
	const written = stringify.mock.calls.length;
	const lane = snapshot(manager);
	expect(stringify.mock.calls.length, "the pending snapshot reuses writer bytes").toBe(written);
	const held = lane.freeze();
	expect(held.transcript.base).toBeNull();
	expect(held.transcript.tail.persistence).toBeNull();
	expect(held.transcript.tail.retainedBytes).toBeGreaterThan(0);
	const before = readTranscriptRoot(held.transcript);
	expect(before.ok && before.entries.at(-1)).toMatchObject({ message: { content: "tail before identity" } });
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	expect(held.transcript.tail.retainedBytes).toBe(0);
	expect(readTranscriptRoot(held.transcript)).toEqual(before);
});

// #4347 / RULING-31: append and repeat flush reuse the first descriptor capture.
it("captures once for each create and atomic replacement, never for appends or repeat flushes", async () => {
	const stat = vi.mocked(fs.fstat).mockClear();
	const manager = create();
	const id = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(1);
	for (let index = 0; index < 8; index++) manager.appendCustomEntry("next", { index });
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(1);
	manager.createBranchedSession(id);
	const pending = snapshot(manager);
	expect(pending.freeze().transcript.tail.persistence).toBeNull();
	await manager.persistHeaderNow();
	expect(stat).toHaveBeenCalledTimes(2);
	pending.applyTranscript(manager.drainTranscript());
	expect(pending.freeze().transcript.tail.retainedBytes).toBe(0);
});
