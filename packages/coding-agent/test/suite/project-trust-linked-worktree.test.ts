/**
 * A linked git worktree inherits the project-trust decision of its repository's main checkout.
 * Tools that run one agent per worktree (Orca's `~/orca/workspaces/<repo>/<name>`) put the worktree
 * outside the main checkout, so before this every new worktree of a trusted repository stopped at
 * "Trust project folder?" before its first turn. The fixtures write exactly the files
 * `git worktree add` writes (no git is spawned, as the trust store spawns none either).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { ProjectTrustContext } from "../../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../../src/core/project-trust.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";

let scratch: string;
let store: ProjectTrustStore;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-worktree-trust-")));
	mkdirSync(join(scratch, "home"), { recursive: true });
	vi.stubEnv("HOME", join(scratch, "home"));
	mkdirSync(join(scratch, "agent"), { recursive: true });
	store = new ProjectTrustStore(join(scratch, "agent"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

interface LinkedWorktree {
	readonly main: string;
	readonly worktree: string;
	readonly admin: string;
}

/** A main checkout at `projects/repo/` and a linked worktree outside it, as `git worktree add` lays them out. */
function linkedWorktree(name = "wt"): LinkedWorktree {
	const main = join(scratch, "projects", "repo");
	const worktree = join(scratch, "workspaces", "repo", name);
	const admin = join(main, ".git", "worktrees", name);
	mkdirSync(admin, { recursive: true });
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(admin, "HEAD"), `ref: refs/heads/${name}\n`);
	writeFileSync(join(admin, "commondir"), "../..\n");
	writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
	writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
	return { main, worktree, admin };
}

function promptSpy(): { context: ProjectTrustContext; prompts: string[] } {
	const prompts: string[] = [];
	const context: ProjectTrustContext = {
		cwd: "",
		mode: "tui",
		hasUI: true,
		ui: {
			select: async (title) => {
				prompts.push(title);
				return undefined;
			},
			confirm: () => Promise.reject(new Error("the trust prompt uses select")),
			input: () => Promise.reject(new Error("the trust prompt uses select")),
			notify: () => {},
		},
	};
	return { context, prompts };
}

describe("a linked git worktree inherits its main checkout's project trust", () => {
	it("a worktree of a trusted main checkout is trusted, and so is a folder inside it", () => {
		const { main, worktree } = linkedWorktree();
		mkdirSync(join(worktree, "packages", "app"), { recursive: true });
		store.set(main, true);

		expect(store.get(worktree)).toBe(true);
		expect(store.get(join(worktree, "packages", "app"))).toBe(true);
	});

	it("a worktree of an untrusted main checkout is untrusted", () => {
		const { main, worktree } = linkedWorktree();
		store.set(main, false);

		expect(store.get(worktree)).toBe(false);
	});

	it("a main checkout under a trusted parent folder passes that trust on", () => {
		const { worktree } = linkedWorktree();
		store.set(join(scratch, "projects"), true);

		expect(store.get(worktree)).toBe(true);
	});

	it("a decision saved for the worktree, or a folder above it, wins over the main checkout", () => {
		const { main, worktree } = linkedWorktree();
		store.set(main, true);
		store.set(worktree, false);
		expect(store.get(worktree)).toBe(false);

		store.set(worktree, null);
		store.set(join(scratch, "workspaces"), false);
		expect(store.get(worktree)).toBe(false);
	});

	it("an undecided main checkout leaves the worktree undecided", () => {
		const { worktree } = linkedWorktree();

		expect(store.get(worktree)).toBeNull();
	});

	it("a worktree whose admin directory does not point back at it inherits nothing", () => {
		const { main, worktree, admin } = linkedWorktree();
		writeFileSync(join(admin, "gitdir"), `${join(scratch, "elsewhere", ".git")}\n`);
		store.set(main, true);

		expect(store.get(worktree)).toBeNull();
	});

	it("a submodule-style gitdir without a commondir inherits nothing", () => {
		const { main, worktree, admin } = linkedWorktree();
		rmSync(join(admin, "commondir"));
		store.set(main, true);

		expect(store.get(worktree)).toBeNull();
	});

	it("a worktree of a bare or separate-git-dir repository inherits nothing", () => {
		const commonDir = join(scratch, "store.git");
		const admin = join(commonDir, "worktrees", "wt");
		const worktree = join(scratch, "workspaces", "store", "wt");
		mkdirSync(admin, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(admin, "commondir"), "../..\n");
		writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
		writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
		store.set(commonDir, true);

		expect(store.get(worktree)).toBeNull();
	});

	it("a main checkout whose .git is not the common dir is not trusted through it", () => {
		const { main, worktree } = linkedWorktree();
		rmSync(join(main, ".git"), { recursive: true });
		writeFileSync(join(main, ".git"), "gitdir: /somewhere/else\n");
		store.set(main, true);

		expect(store.get(worktree)).toBeNull();
	});

	it("starting in a worktree of a trusted repository does not ask, and an untrusted one still asks", async () => {
		const { main, worktree } = linkedWorktree();
		mkdirSync(join(worktree, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(worktree, CONFIG_DIR_NAME, "settings.json"), "{}");

		const untrusted = promptSpy();
		await expect(
			resolveProjectTrusted({ cwd: worktree, trustStore: store, projectTrustContext: untrusted.context }),
		).resolves.toBe(false);
		expect(untrusted.prompts).toHaveLength(1);

		store.set(main, true);
		const trusted = promptSpy();
		await expect(
			resolveProjectTrusted({ cwd: worktree, trustStore: store, projectTrustContext: trusted.context }),
		).resolves.toBe(true);
		expect(trusted.prompts).toEqual([]);
	});
});
