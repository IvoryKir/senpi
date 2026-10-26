// Desktop#4753: the desktop must ask the session engine's own selector, without starting a host or writing state.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoots: string[] = [];
const brand = {
	name: "omo",
	configDir: ".omo",
	envPrefix: "OMO",
	flatLayout: false,
	userAgent: "omo",
};

function fixture(input: { readonly selector?: string; readonly project?: boolean; readonly branded?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "agent-dir-command-"));
	fixtureRoots.push(root);
	const home = join(root, "home");
	const cwd = join(home, "project", "nested");
	const selected = join(root, "selected-store");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(selected);
	const configDir = input.branded ? ".omo" : ".senpi";
	if (input.project) mkdirSync(join(home, "project", configDir, "agent"), { recursive: true });
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		PI_OFFLINE: "1",
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "runtime-cache"),
		NODE_COMPILE_CACHE: join(root, "compile-cache"),
		...(input.branded ? { SENPI_BRAND: JSON.stringify(brand) } : {}),
		...(input.selector ? { [input.selector]: selected } : {}),
	};
	writeFileSync(join(selected, "auth.json"), '{"fixture":"unchanged"}\n');
	return { root, home, cwd, selected, env };
}

function tree(path: string): readonly string[] {
	return readdirSync(path, { recursive: true }).map(String).sort();
}

function run(entry: "cli.ts" | "cli-main.ts", box: ReturnType<typeof fixture>) {
	return spawnSync("bun", [join(packageRoot, "src", entry), "config", "agent-dir", "--json"], {
		cwd: box.cwd,
		env: box.env,
		encoding: "utf8",
		timeout: 10_000,
	});
}

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only agent-directory command", () => {
	it.each([
		{ selector: "SENPI_CODING_AGENT_DIR", branded: false, project: false, rule: "environment" },
		{ selector: "PI_CODING_AGENT_DIR", branded: false, project: false, rule: "environment" },
		{ selector: "OMO_CODING_AGENT_DIR", branded: true, project: false, rule: "environment" },
		{ selector: undefined, branded: true, project: true, rule: "project-local" },
		{ selector: undefined, branded: false, project: true, rule: "project-local" },
		{ selector: undefined, branded: true, project: false, rule: "home-default" },
	])("matches the canonical selector for $selector / $rule / brand=$branded", (input) => {
		const box = fixture(input);
		const before = tree(box.home);
		const result = run("cli.ts", box);
		expect(result.status, result.stderr).toBe(0);
		const canonical = spawnSync(
			"bun",
			[
				"--eval",
				`import { getAgentDir } from ${JSON.stringify(join(packageRoot, "src/config.ts"))}; console.log(getAgentDir());`,
			],
			{ cwd: box.cwd, env: box.env, encoding: "utf8", timeout: 10_000 },
		);
		expect(canonical.status, canonical.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			dir: canonical.stdout.trim(),
			source: input.selector ?? (input.project ? "project-local" : "default"),
			rule: input.rule,
			brandedPrefix: input.branded ? "OMO" : "SENPI",
		});
		expect(tree(box.home)).toEqual(before);
		expect(tree(box.selected)).toEqual(["auth.json"]);
	});

	it("also bypasses full startup on the direct compiled-entry path", () => {
		const box = fixture({ selector: "OMO_CODING_AGENT_DIR", branded: true });
		const before = tree(box.home);
		const result = run("cli-main.ts", box);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			dir: box.selected,
			source: "OMO_CODING_AGENT_DIR",
			rule: "environment",
			brandedPrefix: "OMO",
		});
		expect(tree(box.home)).toEqual(before);
	});
});
