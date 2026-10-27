import { basename } from "node:path";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import type { CompactStorageIo, CompactStorageOperation } from "../../../src/modes/rpc/compact-storage-io.ts";

/** One spool file create, attributed to the storage job that made it. */
export interface RoundWrite {
	readonly name: string;
	readonly bytes: number;
	readonly job: CompactStorageOperation | undefined;
}

export const SPREAD_KEYS = 128;

export function memoryIo(files = new Map<string, Buffer>()): CompactStorageIo {
	return {
		async writeFile(path, data) {
			files.set(path, Buffer.from(data));
		},
		async readFile(path, range) {
			const data = files.get(path);
			if (!data) throw new Error("missing backing file");
			return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
		},
		async unlink(path) {
			files.delete(path);
		},
	};
}

/**
 * A paged index with `count` settled rows, then one compaction round of `SPREAD_KEYS` new keys spread
 * across the key space (one per `count / 128` existing rows), which copies a distinct root path per key.
 */
export function spreadRoundRig(count: number, dir: string, io: CompactStorageIo) {
	const writes: RoundWrite[] = [];
	let job: CompactStorageOperation | undefined;
	const store = new CompactContentStore({
		dir,
		io: {
			...io,
			writeFile(path, data) {
				writes.push({ name: basename(path), bytes: data.byteLength, job });
				return io.writeFile(path, data);
			},
		},
	});
	const enqueue = store.enqueue.bind(store);
	store.enqueue = (operation, work) =>
		enqueue(operation, async () => {
			const outer = job;
			job = operation;
			try {
				await work();
			} finally {
				job = outer;
			}
		});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const compactor = index["compactor"];
	const schedule = compactor.schedule.bind(compactor);
	const width = String(count).length;
	const key = (n: number) => String(n).padStart(width, "0");
	const spreadKey = (k: number) => `${key(Math.floor((k * count) / SPREAD_KEYS))}~`;
	return {
		store,
		index,
		writes,
		spreadKey,
		/** Settles every row into the paged base, then stages the spread keys as pending overlays. */
		async settle(): Promise<void> {
			compactor.schedule = () => undefined;
			for (let n = 0; n < count; n++) index.set(key(n), { n });
			await store.idle();
			compactor.schedule = schedule;
			index.maybeCompact();
			await store.idle();
			compactor.schedule = () => undefined;
			for (let k = 0; k < SPREAD_KEYS; k++) index.set(spreadKey(k), { n: -k });
			await store.idle();
		},
		/** Runs exactly one compaction round and returns the files its job created. */
		async round(): Promise<RoundWrite[]> {
			const start = writes.length;
			let started = false;
			compactor.schedule = () => {
				if (started) return;
				started = true;
				schedule();
			};
			index.maybeCompact();
			await store.idle();
			return writes.slice(start).filter((write) => write.job === "page_write");
		},
	};
}
