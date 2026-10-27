import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// knip skips export checks for entries it finds only through package.json scripts or workflow `run:` lines unless
// knip.jsonc lists them under `entry` in a workspace with `includeEntryExports` (senpi#4421). This test rebuilds that
// run-by-path list from the repo, appends one unused export to every listed file in a temp copy, runs knip once, and
// requires every probe to be reported.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /^[^*?{}$]+\.[cm]?[jt]s$/;
const EXECUTORS = new Set(["node", "bun", "tsx"]);
const VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C", "--cwd", "--env-file", "--preload", "--tsconfig"]);

const readJsonc = (path) =>
	JSON.parse(
		readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n")
			.replace(/,(\s*[}\]])/g, "$1"),
	);

function workspaceDirs() {
	const patterns = [...JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).workspaces, ...Object.keys(readJsonc(join(repo, "knip.jsonc")).workspaces)];
	const dirs = new Set(["."]);
	for (const pattern of patterns) {
		const candidates = pattern.endsWith("/*")
			? readdirSync(join(repo, pattern.slice(0, -2)), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${pattern.slice(0, -2)}/${d.name}`)
			: [pattern];
		for (const dir of candidates) if (existsSync(join(repo, dir, "package.json"))) dirs.add(dir);
	}
	return [...dirs];
}

// Every command a workspace package.json script or a workflow step runs, with the directory it runs in.
function commands() {
	const out = [];
	for (const dir of workspaceDirs()) {
		const scripts = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).scripts ?? {};
		for (const [name, command] of Object.entries(scripts)) out.push({ cwd: dir, command, source: `${dir}/package.json#${name}` });
	}
	const workflows = join(repo, ".github/workflows");
	for (const file of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f))) {
		const lines = readFileSync(join(workflows, file), "utf8").split("\n");
		lines.forEach((line, index) => {
			const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
			if (!run) return;
			const keyIndent = run[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
			const body = [];
			let end = index + 1;
			if (/^[|>]/.test(run[2])) {
				while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > keyIndent)) body.push(lines[end++]);
			} else body.push(run[2]);
			let start = index;
			while (start > 0 && !(lines[start].trimStart().startsWith("- ") && lines[start].search(/\S/) < keyIndent)) start--;
			if (line.trimStart().startsWith("- ")) start = index;
			const dashIndent = lines[start].search(/\S/);
			let stepEnd = end;
			while (stepEnd < lines.length && (lines[stepEnd].trim() === "" || lines[stepEnd].search(/\S/) > dashIndent)) stepEnd++;
			const workdir = lines.slice(start, stepEnd).map((l) => /^\s*working-directory:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
			out.push({ cwd: workdir ?? ".", command: body.join("\n"), source: `.github/workflows/${file}:${index + 1}` });
		});
	}
	return out;
}

// The file each executor (node/bun/tsx) is pointed at: its first positional argument, past flags and their values.
function runByPathFiles({ cwd, command }) {
	const files = [];
	const words = command.split(/[\s;&|()`"']+/).filter(Boolean);
	for (let i = 0; i < words.length; i++) {
		if (!EXECUTORS.has(words[i])) continue;
		let j = i + 1;
		while (j < words.length && words[j].startsWith("-")) j += VALUE_FLAGS.has(words[j]) ? 2 : 1;
		if (words[i] === "bun" && words[j] === "run") j++;
		const arg = words[j];
		if (!arg || !SOURCE.test(arg)) continue;
		const file = relative(repo, resolve(repo, cwd, arg));
		if (!file.startsWith("..") && !file.split("/").includes("node_modules") && existsSync(join(repo, file)) && statSync(join(repo, file)).isFile()) files.push(file);
	}
	return files;
}

function discoverRunByPathEntries() {
	const table = new Map();
	for (const entry of commands()) for (const file of runByPathFiles(entry)) table.set(file, [...new Set([...(table.get(file) ?? []), entry.source])]);
	return [...table].map(([file, sources]) => ({ file, sources })).sort((a, b) => a.file.localeCompare(b.file));
}

function copyRepo(target) {
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, maxBuffer: 64 << 20 }).toString("utf8").split("\0").filter(Boolean);
	for (const file of files) {
		if (!existsSync(join(repo, file))) continue;
		mkdirSync(dirname(join(target, file)), { recursive: true });
		cpSync(join(repo, file), join(target, file), { verbatimSymlinks: true });
	}
	for (const dir of workspaceDirs()) {
		if (existsSync(join(repo, dir, "node_modules"))) symlinkSync(join(repo, dir, "node_modules"), join(target, dir, "node_modules"), "dir");
	}
}

// A file-level `"exports"` baseline ignore would hide the probe in that file, so the temp copy drops it for probed files.
function liftExportIgnores(target, files) {
	const keys = new Set(files.flatMap((file) => workspaceDirs().filter((dir) => dir === "." || file.startsWith(`${dir}/`)).map((dir) => (dir === "." ? file : file.slice(dir.length + 1)))));
	const config = join(target, "knip.jsonc");
	const lifted = readFileSync(config, "utf8").replace(/^(\s*"([^"]+)": \[)(.*)(\],?)$/gm, (line, head, key, values, tail) =>
		keys.has(key) ? `${head}${values.split(",").filter((v) => v.trim() !== '"exports"').join(",")}${tail}` : line,
	);
	writeFileSync(config, lifted);
}

test("knip export-checks every entry run by path from package.json scripts and CI workflows", () => {
	const table = discoverRunByPathEntries();
	assert.ok(table.length > 0, "no run-by-path entries discovered; the package.json/workflow parser is broken");
	const work = mkdtempSync(join(tmpdir(), "knip-entry-probe-"));
	try {
		copyRepo(work);
		const probes = table.map(({ file }, n) => ({ file, name: `zzKnipProbe_${n}` }));
		for (const { file, name } of probes) appendFileSync(join(work, file), `\nexport const ${name} = 1;\n`);
		liftExportIgnores(work, table.map(({ file }) => file));
		const knip = spawnSync(process.execPath, [join(repo, "node_modules/knip/bin/knip.js"), "--reporter", "json", "--no-progress", "--include", "exports"], {
			cwd: work,
			encoding: "utf8",
			maxBuffer: 256 << 20,
		});
		assert.notEqual(knip.stdout.trim(), "", `knip printed no report (status ${knip.status}): ${knip.stderr}`);
		const reported = new Set(JSON.parse(knip.stdout).issues.flatMap((issue) => issue.exports.map((e) => `${issue.file}#${e.name}`)));
		const missing = probes.filter(({ file, name }) => !reported.has(`${file}#${name}`)).map(({ file }) => `${file} (${table.find((t) => t.file === file).sources.join(", ")})`);
		console.log(`knip-entry-probe: ${probes.length} run-by-path entries probed, ${probes.length - missing.length} reported`);
		assert.deepEqual(missing, [], "run-by-path entries whose exports knip does not check; list each under its workspace's `entry` in knip.jsonc (that workspace sets includeEntryExports)");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
