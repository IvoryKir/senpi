// The win32 simulation profile's filesystem half (drive-letter `\` paths, case-insensitive names, EBUSY/EPERM on
// deleting an open file), with the semantics of P0-03i's shared profile (senpi#4510, not merged yet). Once #4510
// lands, win32-sim.test.ts builds its MediaFileSystem on the shared `Win32SimFs` and this file is removed.
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { HeldFile, MediaFileSystem } from "../src/index.ts";

type OpenFileErrorCode = "EBUSY" | "EPERM";

const DRIVE_PATH = /^([A-Za-z]):\\(.*)$/s;

const namesEqual = (left: string, right: string): boolean => left.toUpperCase() === right.toUpperCase();

function openFileError(code: OpenFileErrorCode, syscall: string, target: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`${code}: ${syscall} '${target}'`);
	error.code = code;
	error.syscall = syscall;
	error.path = target;
	return error;
}

const hasCode = (error: unknown, code: string): boolean =>
	error instanceof Error && "code" in error && error.code === code;

export function createWin32SimFileSystem(root: string, deleteOpenFileError: OpenFileErrorCode): MediaFileSystem {
	const openCounts = new Map<string, number>();

	async function resolve(win32Path: string): Promise<string> {
		const match = DRIVE_PATH.exec(path.win32.normalize(win32Path));
		if (match === null)
			throw new TypeError(`win32 sim: expected a drive-letter path, got ${JSON.stringify(win32Path)}`);
		const [, drive = "", rest = ""] = match;
		const segments = rest.split("\\").filter((segment) => segment.length > 0);
		let current = path.join(root, drive.toUpperCase());
		for (const [index, segment] of segments.entries()) {
			let entries: string[];
			try {
				entries = await fsp.readdir(current);
			} catch (error) {
				if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR"))
					return path.join(current, ...segments.slice(index));
				throw error;
			}
			current = path.join(current, entries.find((entry) => namesEqual(entry, segment)) ?? segment);
		}
		return current;
	}

	return {
		join: (...segments) => path.win32.join(...segments),
		resolve,
		mkdir: async (target) => void (await fsp.mkdir(await resolve(target), { recursive: true })),
		async rm(target) {
			const backing = await resolve(target);
			for (const open of openCounts.keys()) {
				if (open === backing || open.startsWith(`${backing}${path.sep}`)) {
					throw openFileError(deleteOpenFileError, "rm", target);
				}
			}
			await fsp.rm(backing, { recursive: true });
		},
		async hold(target): Promise<HeldFile> {
			const backing = await resolve(target);
			openCounts.set(backing, (openCounts.get(backing) ?? 0) + 1);
			let closed = false;
			return {
				close: async () => {
					if (closed) return;
					closed = true;
					const remaining = (openCounts.get(backing) ?? 1) - 1;
					if (remaining === 0) openCounts.delete(backing);
					else openCounts.set(backing, remaining);
				},
			};
		},
	};
}
