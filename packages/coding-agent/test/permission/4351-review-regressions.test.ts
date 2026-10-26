import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { appendApproved, loadApproved } from "../../src/core/extensions/builtin/permission-system/storage.ts";

describe("4351 binding review regressions", () => {
	let root: string;
	let cwd: string;
	let outside: string;
	const registry = createBuiltinParserRegistry();

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-4351-")));
		cwd = join(root, "project");
		outside = join(root, "Outside");
		mkdirSync(cwd);
		mkdirSync(outside);
		writeFileSync(join(outside, "File.txt"), "fixture");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const external = (tool: string, input: Record<string, unknown>, cwd: string) => {
		const request = registry.parse(tool, input, cwd).find((item) => item.permission === "external_directory");
		if (!request) throw new Error("Missing external-directory request");
		return request;
	};

	for (const suffix of ["File.txt", "missing/nested/file.txt"]) {
		it(`H1: denies both spellings of an external case alias: ${suffix}`, (context) => {
			const alternate = join(root, "outside");
			try {
				const actual = statSync(outside);
				const alias = statSync(alternate);
				if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return context.skip();
			}
			for (const rulePath of [join(outside, suffix), join(alternate, suffix)]) {
				const service = new PermissionService(
					[
						{ permission: "external_directory", pattern: "*", action: "allow" },
						{ permission: "external_directory", pattern: rulePath, action: "deny" },
					],
					[],
				);
				for (const target of [join(outside, suffix), join(alternate, suffix)]) {
					const request = external("write", { path: target }, cwd);
					expect(service.dispatchDecision(request.permission, request.patterns).action).toBe("deny");
				}
			}
		});
	}

	// senpi#4351 H1-GLOB: case changes after the first wildcard must not evade a deny.
	for (const [pattern, direct, alternate] of [
		["*.json", "package.json", "PACKAGE.JSON"],
		["*.JSON", "package.json", "PACKAGE.JSON"],
		["*a*.json", "package.json", "PACKAGE.JSON"],
		["*/File.txt", "Nested/File.txt", "NESTED/FILE.TXT"],
		["*/Nested/*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*?Nested?*.txt", "dir/Nested/File.txt", "DIR/NESTED/FILE.TXT"],
		["*/Nested/missing/new.txt", "dir/Nested/missing/new.txt", "DIR/NESTED/missing/new.txt"],
	]) {
		it(`H1-GLOB: denies both case spellings for ${pattern}`, (context) => {
			writeFileSync(join(outside, "package.json"), "{}");
			mkdirSync(join(outside, "Nested"));
			writeFileSync(join(outside, "Nested", "File.txt"), "fixture");
			mkdirSync(join(outside, "dir", "Nested"), { recursive: true });
			writeFileSync(join(outside, "dir", "Nested", "File.txt"), "fixture");
			const actual = statSync(join(outside, "package.json"), { bigint: true });
			try {
				const alias = statSync(join(outside, "PACKAGE.JSON"), { bigint: true });
				expect(alias.dev).toBe(actual.dev);
				expect(alias.ino).toBe(actual.ino);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return context.skip();
			}
			const service = new PermissionService(
				[
					{ permission: "external_directory", pattern: "*", action: "allow" },
					{ permission: "external_directory", pattern: `${outside}/${pattern}`, action: "deny" },
				],
				[],
			);
			for (const target of [direct, alternate]) {
				const request = external("write", { path: join(outside, target) }, cwd);
				expect(service.dispatchDecision(request.permission, request.patterns).action).toBe("deny");
			}
			const missing = external("write", { path: join(outside, "dir/Nested/missing/NEW.TXT") }, cwd);
			if (pattern.endsWith("missing/new.txt")) {
				expect(service.dispatchDecision(missing.permission, missing.patterns).action).toBe("allow");
			}
		});
	}

	it("H1-GLOB: keeps distinct case-sensitive suffixes separate", (context) => {
		writeFileSync(join(outside, "package.json"), "{}");
		try {
			writeFileSync(join(outside, "PACKAGE.JSON"), "other", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return context.skip();
		}
		expect(statSync(join(outside, "package.json")).ino).not.toBe(statSync(join(outside, "PACKAGE.JSON")).ino);
		const service = new PermissionService(
			[
				{ permission: "external_directory", pattern: "*", action: "allow" },
				{ permission: "external_directory", pattern: `${outside}/*.json`, action: "deny" },
			],
			[],
		);
		for (const [target, action] of [
			["package.json", "deny"],
			["PACKAGE.JSON", "allow"],
		]) {
			const request = external("write", { path: join(outside, target) }, cwd);
			expect(service.dispatchDecision(request.permission, request.patterns).action).toBe(action);
		}
	});

	it("H1: reuses persisted Always scopes across external case aliases", async (context) => {
		const alternate = join(root, "outside");
		try {
			const actual = statSync(outside);
			const alias = statSync(alternate);
			if (actual.dev !== alias.dev || actual.ino !== alias.ino) return context.skip();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return context.skip();
		}
		const emitter = createLocalEventEmitter();
		const service = new PermissionService([], [], emitter);
		emitter.onAsked((request) => service.reply({ requestID: request.id, reply: "always" }));
		const request = external("write", { path: join(alternate, "missing", "file.txt") }, cwd);
		await service.ask({ ...request, sessionID: "case", metadata: {} });
		const agentDir = join(root, "agent");
		appendApproved(agentDir, cwd, service.getSessionApproved());
		const reloaded = new PermissionService([], loadApproved(agentDir, cwd));
		const direct = external("write", { path: join(outside, "missing", "other.txt") }, cwd);
		expect(reloaded.dispatchDecision(direct.permission, direct.patterns).action).toBe("allow");
		expect(reloaded.dispatchDecision("external_directory", join(root, "sibling.txt")).action).toBe("ask");
	});

	it("H1: keeps distinct case-sensitive external directories separate", (context) => {
		const other = join(root, "outside");
		try {
			mkdirSync(other);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return context.skip();
		}
		const service = new PermissionService(
			[{ permission: "external_directory", pattern: `${outside}/*`, action: "deny" }],
			[{ permission: "external_directory", pattern: `${other}/*`, action: "allow" }],
		);
		expect(service.dispatchDecision("external_directory", join(outside, "new.txt")).action).toBe("deny");
		expect(service.dispatchDecision("external_directory", join(other, "new.txt")).action).toBe("allow");
	});

	it.each(["bash", "bash_input", "monitor"])(
		"H2: %s Always approves only the resolved trailing-slash directory",
		async (tool) => {
			const directory = join(outside, "changes");
			mkdirSync(directory);
			const alias = join(root, "alias");
			symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
			const command = `ls "${alias}/"`;
			const request = external(tool, tool === "bash_input" ? { input: command } : { command }, cwd);
			const emitter = createLocalEventEmitter();
			const service = new PermissionService([], [], emitter);
			const sibling = join(outside, "package.json");
			expect(service.dispatchDecision("external_directory", sibling).action).toBe("ask");
			emitter.onAsked((pending) => service.reply({ requestID: pending.id, reply: "always" }));
			await service.ask({ ...request, sessionID: "scope", metadata: {} });
			expect(service.dispatchDecision("external_directory", sibling).action).toBe("ask");
			expect(service.dispatchDecision("external_directory", directory).action).toBe("ask");
			expect(service.getSessionApproved()).toEqual([
				{ permission: "external_directory", pattern: `${directory}/*`, action: "allow" },
			]);
			expect(service.dispatchDecision("external_directory", join(directory, "entry.txt")).action).toBe("allow");
		},
	);
});
