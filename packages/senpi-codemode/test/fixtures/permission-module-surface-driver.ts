import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import type { CellPermissionState } from "../../src/kernels/js/kernel-contract.ts";

const root = mkdtempSync(join(tmpdir(), "permission-module-surface-"));
const failures: string[] = [];
let passed = 0;

// The engine's own view of the module, measured in this process: a cell that is not being enforced
// must see exactly this, not a narrowed stand-in.
const native = process.getBuiltinModule("node:worker_threads");
const nativeKeys = Object.keys(native).sort().join(",");

// isMainThread is read by type, not by value: a cell runs on a worker thread and this driver does not.
const surface = `const wt=require("node:worker_threads");
return JSON.stringify([typeof wt.Worker, typeof wt.isMainThread, typeof wt.receiveMessageOnPort, Object.keys(wt).sort().join(",")]);`;
const reduced = `const wt=require("node:worker_threads");
return JSON.stringify([wt.Worker===undefined, wt.parentPort===undefined, wt.workerData===undefined, wt.MessageChannel===globalThis.MessageChannel]);`;
const imported = `try{await import("node:worker_threads");return "loaded";}catch(error){return error?.code ?? error?.name ?? "none";}`;

const states: { readonly row: string; readonly state?: CellPermissionState }[] = [
	{ row: "no permissions" },
	{ row: "inactive", state: { epoch: 1, active: false, rules: [] } },
	{
		row: "active deny",
		state: { epoch: 1, active: true, rules: [{ permission: "write", pattern: "*", layer: "user" }] },
	},
];

async function run(state: CellPermissionState | undefined, code: string): Promise<string> {
	const dir = mkdtempSync(join(root, "row-"));
	const kernel = new JavaScriptKernel({
		sessionId: crypto.randomUUID(),
		cwd: dir,
		parallelPoolWidth: 2,
		...(state
			? {
					permissions: {
						checkDeadlineMs: 120_000,
						state: () => state,
						decide: () => ({ action: "pass" as const }),
					},
				}
			: {}),
	});
	try {
		const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 120_000 });
		return result.ok ? String(JSON.parse(result.valueRepr ?? '""')) : `CELLERR:${result.error?.code}`;
	} finally {
		await kernel.close();
	}
}

const expect = async (row: string, actual: Promise<string>, want: string) => {
	try {
		assert.equal(await actual, want);
		passed++;
	} catch (error) {
		failures.push(`${row}: ${String(error)}`);
	}
};

// A cell's own worker reaches its own workerData and parentPort through this module (#4387), and the
// constructor it finds there is the guarded one, so it cannot start a worker this kernel never
// interposed. Enforcement is on for this row, because that is where both used to break.
async function userWorkerView(): Promise<string> {
	const dir = mkdtempSync(join(root, "user-worker-"));
	const child = join(dir, "child.mjs");
	writeFileSync(
		child,
		`const wt = require("node:worker_threads");
postMessage({ data: wt.workerData, guarded: wt.Worker === globalThis.Worker, port: wt.parentPort !== undefined });`,
	);
	return await run(
		{ epoch: 1, active: true, rules: [{ permission: "write", pattern: "*", layer: "user" }] },
		`const child=new Worker(${JSON.stringify(pathToFileURL(child).href)},{workerData:"payload"});
try{
	const reply=await new Promise((resolve,reject)=>{child.onmessage=(event)=>resolve(event.data);child.onerror=(event)=>reject(new Error(event.message));});
	return JSON.stringify([reply.data, reply.guarded, reply.port]);
}finally{child.terminate();}`,
	);
}

try {
	await expect("user worker/own view", userWorkerView(), JSON.stringify(["payload", true, true]));
	for (const { row, state } of states) {
		const enforced = state?.active === true;
		if (enforced) {
			// Enforcement is on: the escaping bindings are gone and only the port primitives the cell
			// already owns as globals remain.
			await expect(`${row}/require`, run(state, reduced), JSON.stringify([true, true, true, true]));
			await expect(`${row}/import`, run(state, imported), "cell_permission_denied");
		} else {
			// Nothing is enforced, so the cell must see the engine's own module, export for export.
			await expect(
				`${row}/require`,
				run(state, surface),
				JSON.stringify(["function", "boolean", "function", nativeKeys]),
			);
			await expect(`${row}/import`, run(state, imported), "loaded");
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures, nativeExports: Object.keys(native).length }));
process.exitCode = failures.length ? 1 : 0;
