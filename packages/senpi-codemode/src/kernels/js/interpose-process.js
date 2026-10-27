import { replaceMethod, requestedPath } from "./interpose-paths.js";

const { basename } = process.getBuiltinModule("node:path");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const cwdOf = (value) => requestedPath(value) ?? process.cwd();

export function installProcessPermissions(check, files) {
	const cp = process.getBuiltinModule("node:child_process");
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		replaceMethod(cp, name, (original) => function (...parameters) {
			check(() => {
				const [file, args, options] = parameters;
				const shellText = name === "exec" || name === "execSync";
				const argv = Array.isArray(args) ? args : [];
				const opts = shellText ? args : Array.isArray(args) || args == null ? options : args;
				const shell = opts?.shell;
				const command = name === "fork"
					? [opts?.execPath ?? process.execPath, ...(opts?.execArgv ?? process.execArgv), file, ...argv].map(quote).join(" ")
					: shellText ? file : shell ? [file, ...argv].join(" ") : [file, ...argv].map(quote).join(" ");
				return {
					call: { tool: "bash", input: { command }, cwd: cwdOf(opts?.cwd) },
					unsupported: typeof shell === "string" && !/^(?:sh|bash|zsh|dash)$/u.test(basename(shell)),
				};
			});
			return original.apply(this, parameters);
		});
	}
	const bun = globalThis.Bun;
	if (!bun) return;
	for (const name of ["spawn", "spawnSync"]) replaceMethod(bun, name, (original) => function (...parameters) {
		const [first, second] = parameters;
		const options = Array.isArray(first) ? second : first;
		check(() => {
			const argv = Array.isArray(first) ? first : first?.cmd;
			return {
				call: { tool: "bash", input: { command: Array.isArray(argv) ? argv.map(quote).join(" ") : "" }, cwd: cwdOf(options?.cwd) },
				unsupported: !Array.isArray(argv),
			};
		});
		const slots = Array.isArray(options?.stdio) ? options.stdio : [];
		files.source(options?.stdin ?? slots[0]); // sink:spawn-stdin
		files.handle(options?.stdout ?? slots[1], "write"); // sink:spawn-stdout
		files.handle(options?.stderr ?? slots[2], "write"); // sink:spawn-stderr
		return original.apply(this, parameters);
	});
	const shell = bun.$;
	if (typeof shell !== "function") return;
	let shellCwd;
	const render = (value) => {
		if (Array.isArray(value)) return value.map(render).join(" ");
		if (value && typeof value === "object") {
			if (typeof value.raw === "string") return value.raw;
			check(() => ({ unsupported: true }));
		}
		return shell.escape(String(value));
	};
	const guarded = function (strings, ...values) {
		check(() => ({
			call: {
				tool: "bash",
				input: { command: strings.map((part, index) => part + (index < values.length ? render(values[index]) : "")).join("") },
				cwd: cwdOf(shellCwd),
			},
		}));
		return shell(strings, ...values);
	};
	for (const key of Reflect.ownKeys(shell)) {
		if (key !== "Shell" && !Object.hasOwn(guarded, key)) Object.defineProperty(guarded, key, Object.getOwnPropertyDescriptor(shell, key));
	}
	for (const name of ["cwd", "env", "nothrow", "throws"]) {
		if (typeof shell[name] !== "function") continue;
		guarded[name] = (...args) => {
			if (name === "cwd") shellCwd = args[0];
			shell[name](...args);
			return guarded;
		};
	}
	if (shell.Shell) guarded.Shell = new Proxy(shell.Shell, {
		construct(target, args, newTarget) {
			check(() => ({ unsupported: true }));
			return Reflect.construct(target, args, newTarget);
		},
	});
	bun.$ = guarded;
}
