import { checkPath, requestedPath } from "./interpose-paths.js";

const { dirname, isAbsolute, resolve } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

export function installModulePermissions(check) {
	const module = process.getBuiltinModule("node:module");
	const nativeRequire = module.createRequire(import.meta.url);
	const resolveSync = globalThis.Bun?.resolveSync;
	const engineModules = new Set();
	let sealed = false;
	const forbidden = /^(?:bun:ffi|(?:node:)?(?:vm|worker_threads))$/u;
	const pathLike = (name) => name.startsWith(".") || isAbsolute(name) || name.startsWith("file:");
	const guard = (source, importer) => {
		const specifier = String(source);
		if (!sealed) {
			engineModules.add(importer);
			return;
		}
		if (forbidden.test(specifier) || specifier.endsWith(".node")) check(() => ({ unsupported: true }));
		if (!pathLike(specifier)) return;
		const parent = importer?.startsWith("file:") ? fileURLToPath(importer) : importer;
		const base = parent ? dirname(parent) : process.cwd();
		const candidate = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
		let target;
		try {
			target = resolveSync ? resolveSync(candidate, base) : nativeRequire.resolve(resolve(base, candidate));
		} catch {
			target = isAbsolute(candidate) ? candidate : resolve(base, candidate);
		}
		checkPath(check, "read", target);
	};
	// Only resolution is observed: Bun owns every loader and import attribute.
	if (globalThis.Bun?.plugin) {
		Bun.plugin({
			name: "senpi-cell-permissions",
			setup(build) {
				build.onResolve({ filter: /.*/u }, (args) => { guard(args.path, args.importer); });
			},
		});
	}
	const originalRequire = module.prototype.require;
	module.prototype.require = function (specifier) {
		guard(specifier, this.filename);
		if (specifier === "bun" && globalThis.Bun) return globalThis[Symbol.for("senpi.kernel.bun")] ?? globalThis.Bun;
		return originalRequire.call(this, specifier);
	};
	const originalCreateRequire = module.createRequire;
	module.createRequire = function (...args) {
		const require = originalCreateRequire.apply(this, args);
		const guarded = function (specifier) {
			guard(specifier, requestedPath(args[0]) ?? String(args[0]));
			if (specifier === "bun" && globalThis.Bun) return globalThis[Symbol.for("senpi.kernel.bun")] ?? globalThis.Bun;
			return require(specifier);
		};
		Object.assign(guarded, require);
		guarded.cache = new Proxy(require.cache, {
			set(target, name, value) { check(() => ({ unsupported: true })); return Reflect.set(target, name, value); },
			deleteProperty(target, name) { check(() => ({ unsupported: true })); return Reflect.deleteProperty(target, name); },
			defineProperty(target, name, descriptor) { check(() => ({ unsupported: true })); return Reflect.defineProperty(target, name, descriptor); },
		});
		return guarded;
	};
	const getBuiltin = process.getBuiltinModule;
	process.getBuiltinModule = function (name) {
		if (sealed && forbidden.test(name)) check(() => ({ unsupported: true }));
		return getBuiltin.call(this, name);
	};
	Object.defineProperty(globalThis, Symbol.for("senpi.kernel.permissionImport"), { value: guard });
	return () => { sealed = true; Object.freeze(engineModules); };
}
