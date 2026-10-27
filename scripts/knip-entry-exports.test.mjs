import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { knipEntryTable } from "./knip-entry-table.test-support.mjs";

// knip checks an entry file's exports only when the file comes from a workspace's configured `entry` list in a
// workspace with includeEntryExports; a file it resolves only from a command (a package.json script, a workflow `run:`
// line, a tool config) stays an entry whose exports it never reads (senpi#4421). This test:
//   1. takes the table from knip's own resolved entries (knip-entry-table.test-support.mjs),
//   2. cross-checks knip against a coarse scan of package.json scripts and workflow lines, which can only add: a source
//      file the scan sees on a command line that knip does not list as an entry of any kind fails the test by name,
//   3. appends one unused export to every table file in a temp copy, runs knip once, and requires every probe reported.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_TOKEN = /[\w@./-]+\.(?:[cm]?[jt]s|tsx)(?![\w-])/g;
const EXECUTOR_LINE = /\b(?:node|bun|bunx|tsx|npx|deno)\b/;

// Every source path that appears on a line that runs an executor, resolved against the line's package directory and
// every workspace directory (a command may `cd`, pass `--cwd` or set working-directory). It over-matches on
// purpose; paths that are not files are dropped, and nothing it finds ever removes a table entry.
function scannedRunByPath(workspaceDirs) {
	const lines = [];
	for (const dir of workspaceDirs) {
		const scripts = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).scripts ?? {};
		for (const [name, command] of Object.entries(scripts)) lines.push({ text: command, bases: [dir, ...workspaceDirs], source: `${dir}/package.json#${name}` });
	}
	const workflows = join(repo, ".github/workflows");
	for (const file of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f))) {
		readFileSync(join(workflows, file), "utf8")
			.split("\n")
			.forEach((text, index) => lines.push({ text, bases: [".", ...workspaceDirs], source: `.github/workflows/${file}:${index + 1}` }));
	}
	const found = new Map();
	for (const { text, bases, source } of lines) {
		if (!EXECUTOR_LINE.test(text)) continue;
		for (const token of text.match(SOURCE_TOKEN) ?? []) {
			if (token.includes("node_modules/")) continue;
			for (const base of bases) {
				const file = relative(repo, resolve(repo, base, token));
				if (file.startsWith("..") || !existsSync(join(repo, file)) || !statSync(join(repo, file)).isFile()) continue;
				if (!found.has(file)) found.set(file, new Set());
				found.get(file).add(source);
			}
		}
	}
	return found;
}

function copyRepo(target, workspaceDirs) {
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, maxBuffer: 64 << 20 }).toString("utf8").split("\0").filter(Boolean);
	for (const file of files) {
		if (!existsSync(join(repo, file))) continue;
		mkdirSync(dirname(join(target, file)), { recursive: true });
		cpSync(join(repo, file), join(target, file), { verbatimSymlinks: true });
	}
	for (const dir of workspaceDirs) {
		if (existsSync(join(repo, dir, "node_modules"))) symlinkSync(join(repo, dir, "node_modules"), join(target, dir, "node_modules"), "dir");
	}
}

// A file-level `"exports"` baseline ignore would hide the probe in that file, so the temp copy drops it for probed files.
function liftExportIgnores(target, files, workspaceDirs) {
	const keys = new Set(files.flatMap((file) => workspaceDirs.filter((dir) => dir === "." || file.startsWith(`${dir}/`)).map((dir) => (dir === "." ? file : file.slice(dir.length + 1)))));
	const config = join(target, "knip.jsonc");
	const lifted = readFileSync(config, "utf8").replace(/^(\s*"([^"]+)": \[)(.*)(\],?)$/gm, (line, head, key, values, tail) =>
		keys.has(key) ? `${head}${values.split(",").filter((v) => v.trim() !== '"exports"').join(",")}${tail}` : line,
	);
	writeFileSync(config, lifted);
}

test("knip export-checks every entry it resolves, and every file package.json scripts and CI workflows run by path", async () => {
	const { table, entries, workspaceDirs } = await knipEntryTable(repo);
	assert.ok(table.length > 0, "knip reported no entry files; the knip-entry-table hook no longer sees ProjectPrincipal entries");
	assert.ok(entries.some(({ kinds }) => kinds.includes("resolved")), "no command-resolved entries recorded; the knip-entry-table hook is broken");
	const inTable = new Set(table.map(({ file }) => file));
	const knipKinds = new Map(entries.map(({ file, kinds }) => [file, kinds.join("+")]));
	const scanned = scannedRunByPath(workspaceDirs);
	console.log(`knip-entry-crosscheck: ${scanned.size} files seen run by path, ${entries.length} knip entries, ${table.length} in the probe table`);
	const gaps = [...scanned]
		.filter(([file]) => !knipKinds.has(file))
		.map(([file, sources]) => `${file} (run by ${[...sources].join(", ")})`);
	assert.deepEqual(gaps, [], "files run by path that knip does not list as entries; list each under its workspace's `entry` in knip.jsonc");

	const work = mkdtempSync(join(tmpdir(), "knip-entry-probe-"));
	try {
		copyRepo(work, workspaceDirs);
		const probes = table.map(({ file }, n) => ({ file, name: `zzKnipProbe_${n}` }));
		for (const { file, name } of probes) appendFileSync(join(work, file), `\nexport const ${name} = 1;\n`);
		liftExportIgnores(work, [...inTable], workspaceDirs);
		const knip = spawnSync(process.execPath, [join(repo, "node_modules/knip/bin/knip.js"), "--reporter", "json", "--no-progress", "--include", "exports"], {
			cwd: work,
			encoding: "utf8",
			maxBuffer: 256 << 20,
		});
		assert.notEqual(knip.stdout.trim(), "", `knip printed no report (status ${knip.status}): ${knip.stderr}`);
		const reported = new Set(JSON.parse(knip.stdout).issues.flatMap((issue) => issue.exports.map((e) => `${issue.file}#${e.name}`)));
		const missing = probes.filter(({ file, name }) => !reported.has(`${file}#${name}`)).map(({ file }) => `${file} (knip: ${knipKinds.get(file)})`);
		console.log(`knip-entry-probe: ${probes.length} knip entries probed, ${probes.length - missing.length} reported`);
		assert.deepEqual(missing, [], "entries whose exports knip does not check; list each under its workspace's `entry` in a workspace with includeEntryExports");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
