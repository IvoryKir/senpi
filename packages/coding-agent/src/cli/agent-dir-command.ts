import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, CONFIG_FLAT_LAYOUT, ENV_PREFIX, getAgentDir } from "../config.ts";
import { brandEnvNames } from "../core/brand.ts";
import { exitAfterOutput } from "./print-then-exit.ts";

/**
 * A metadata command, before compile-cache setup, settings, migrations, extensions or hosts.
 * The directory is the very same getAgentDir() every session uses; the remaining fields
 * describe that decision rather than choosing another directory.
 */
export async function dispatchAgentDirectoryCommand(args: readonly string[]): Promise<void> {
	if (args[0] !== "config" || args[1] !== "agent-dir") return;
	if (args.length !== 3 || args[2] !== "--json") {
		await exitAfterOutput(`Usage: ${APP_NAME} config agent-dir --json\n`, 2);
	}
	const dir = getAgentDir();
	const selector = brandEnvNames("CODING_AGENT_DIR").find((name) => process.env[name] !== undefined);
	const explicit = selector !== undefined && Boolean(process.env[selector]);
	const homeDefault = CONFIG_FLAT_LAYOUT
		? join(homedir(), CONFIG_DIR_NAME)
		: join(homedir(), CONFIG_DIR_NAME, "agent");
	const rule = explicit ? "environment" : dir === homeDefault ? "home-default" : "project-local";
	await exitAfterOutput(
		`${JSON.stringify({
			dir,
			source: explicit ? selector : rule === "project-local" ? "project-local" : "default",
			rule,
			brandedPrefix: ENV_PREFIX,
		})}\n`,
		0,
	);
}
