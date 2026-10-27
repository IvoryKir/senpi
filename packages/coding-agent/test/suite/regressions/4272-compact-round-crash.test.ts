import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { spoolRoot } from "../compact-storage-support.ts";
import { SPREAD_KEYS, spreadRoundRig } from "./4272-spread-round-support.ts";

const ROWS = 1_024;
const isRoundFile = (name: string) => /^node-/.test(name);

async function spoolFiles(dir: string): Promise<Map<string, number>> {
	const files = new Map<string, number>();
	for (const name of await readdir(dir)) files.set(name, (await stat(join(dir, name))).size);
	return files;
}

/** The round's `crashAfter`-th node file reaches disk, then the process is cut before any later write. */
async function crashedRound(dir: string, crashAfter: number) {
	let armed = false;
	let written = 0;
	const rig = spreadRoundRig(ROWS, dir, {
		...nodeCompactStorageIo,
		async writeFile(path, data) {
			await nodeCompactStorageIo.writeFile(path, data);
			if (armed && isRoundFile(path.slice(dir.length + 1)) && ++written === crashAfter) {
				throw new Error(`crash after round file ${crashAfter}`);
			}
		},
	});
	await rig.settle();
	const before = { base: rig.index.base, pages: [...rig.index.pages], files: await spoolFiles(dir) };
	armed = true;
	await rig.round();
	return { rig, before, written };
}

// senpi#4539 / RULING-54 condition 1: a multi-file round is visible only through its one commit, which comes
// after every file is durable; cut after ANY of its files, the previous state stays fully readable and no stray
// file survives.
it("keeps the previous state readable and reclaims every stray file when the round is cut after each file", async () => {
	const probe = await spoolRoot();
	let roundFiles = 0;
	const whole = spreadRoundRig(ROWS, probe.dir, nodeCompactStorageIo);
	try {
		await whole.settle();
		roundFiles = (await whole.round()).filter((file) => isRoundFile(file.name)).length;
	} finally {
		await whole.store.retire();
		await probe.cleanup();
	}
	expect(roundFiles, "node files in one spread round").toBeGreaterThan(1);
	for (let crashAfter = 1; crashAfter <= roundFiles; crashAfter++) {
		const root = await spoolRoot();
		const { rig, before, written } = await crashedRound(root.dir, crashAfter);
		const at = `cut after file ${crashAfter} of ${roundFiles}`;
		try {
			expect(written, at).toBe(crashAfter);
			expect(rig.store.status(), at).toMatchObject({ spillHalted: true, reclaimDebtBytes: 0 });
			expect(rig.store.status().failures, at).toEqual(
				expect.arrayContaining([expect.objectContaining({ operation: "node_write" })]),
			);
			expect(rig.index.base, at).toBe(before.base);
			expect([...rig.index.pages], at).toEqual(before.pages);
			expect(rig.index.status(), at).toMatchObject({ baseRows: ROWS, overrideSlots: SPREAD_KEYS });
			expect(await spoolFiles(root.dir), `${at}: spool files unchanged, strays reclaimed`).toEqual(before.files);
			const cut = rig.index.freeze();
			try {
				const rows = await rig.index.entries(cut);
				expect(rows.size, at).toBe(ROWS + SPREAD_KEYS);
				expect(rows.get("0512"), at).toEqual({ n: 512 });
				expect(rows.get(rig.spreadKey(5)), at).toEqual({ n: -5 });
				expect(await rig.index.lookup(cut, "1023"), at).toMatchObject({ payload: expect.any(Number) });
			} finally {
				rig.index.release(cut);
			}
		} finally {
			await rig.store.retire();
			await root.cleanup();
		}
	}
}, 120_000);
