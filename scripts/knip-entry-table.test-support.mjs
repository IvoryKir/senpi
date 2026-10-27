import { relative } from "node:path";
import { main } from "knip";
import { createOptions } from "knip/session";
import { ProjectPrincipal } from "../node_modules/knip/dist/ProjectPrincipal.js";

// The entry-export probe table, taken from knip's own resolved entries (senpi#4421).
//
// knip 6.43 has no public API that returns its resolved entry files, and `knip --debug` logs only the entries it finds
// by glob, not the files it resolves from package.json scripts, workflow `run:` lines or tool configs. So this runs
// knip's public `main` once and records every file knip adds through ProjectPrincipal#addEntryPath(s), tagged by how
// knip added it:
//   "entry"     a workspace's configured `entry` list (addEntryPaths with skipExportsAnalysis: false)
//   "resolved"  a file knip resolved from a command or a tool config while reading workspaces (a single addEntryPath
//               before principal.init(); `node scripts/x.mjs`, `--import ./setup.mjs`, a vitest setupFiles path, ...)
//   "plugin"    a plugin convention whose exports knip never checks (test files, framework files)
//   "default"   package.json entries, declaration files and plugin config files
//   "graph"     a file found while walking imports (worker URLs, spawned fixtures, import globs)
// The table is every "entry" and "resolved" file: knip must export-check each of them.

export async function knipEntryTable(cwd) {
	const kinds = new Map();
	const proto = ProjectPrincipal.prototype;
	const original = { addEntryPath: proto.addEntryPath, addEntryPaths: proto.addEntryPaths, init: proto.init };
	let batch;
	let phase = "resolved";
	let principal;
	proto.init = function (...args) {
		phase = "graph";
		return original.init.apply(this, args);
	};
	proto.addEntryPaths = function (filePaths, options) {
		const outer = batch;
		batch = options === undefined ? "default" : options.skipExportsAnalysis ? "plugin" : "entry";
		try {
			return original.addEntryPaths.call(this, filePaths, options);
		} finally {
			batch = outer;
		}
	};
	proto.addEntryPath = function (filePath, options) {
		principal = this;
		original.addEntryPath.call(this, filePath, options);
		if (!this.entryPaths.has(filePath)) return;
		const file = relative(cwd, filePath);
		if (!kinds.has(file)) kinds.set(file, new Set());
		kinds.get(file).add(batch ?? phase);
	};
	let results;
	try {
		results = await main(await createOptions({ cwd, args: {} }));
	} finally {
		Object.assign(proto, original);
	}
	const entries = [...kinds].map(([file, set]) => ({
		file,
		kinds: [...set].sort(),
		exportsAnalyzed: !principal.skipExportsAnalysis.has(`${cwd}/${file}`),
	}));
	const table = entries.filter(({ kinds }) => kinds.includes("entry") || kinds.includes("resolved"));
	return { table: table.sort((a, b) => a.file.localeCompare(b.file)), entries, workspaceDirs: results.includedWorkspaceDirs.map((dir) => relative(cwd, dir) || ".") };
}
