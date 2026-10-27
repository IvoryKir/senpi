import { checkPath, executionPath, replaceMethod } from "./interpose-paths.js";

const READERS = ["text", "json", "bytes", "arrayBuffer", "stream", "formData", "image"];
const WRITERS = ["write", "delete", "unlink"];

export function installBunPermissions(check, resources) {
	const bun = globalThis.Bun;
	const stand = new WeakMap();
	const unwrap = (value) => stand.get(value) ?? value;
	const files = { source: () => {}, destination: () => {}, handle: () => false };
	if (typeof bun?.file === "function") {
		const originalFile = bun.file;
		const proto = Object.getPrototypeOf(originalFile(new URL(import.meta.url)));
		// Captured before any cell runs, so a per-instance "name" cannot redirect a decision away
		// from the path the runtime will actually open.
		const nativePath = Object.getOwnPropertyDescriptor(proto, "name").get;
		const pathOf = (value) => {
			try {
				return nativePath.call(unwrap(value));
			} catch {
				return undefined;
			}
		};
		const granted = (value, mode) => {
			const grant = resources.path(value);
			if (grant === undefined) return false;
			resources.use(typeof grant === "number" ? grant : value, mode);
			return true;
		};
		const handle = (value, mode) => {
			if (typeof value === "number") return granted(value, mode);
			if (value === null || typeof value !== "object") return false;
			const path = pathOf(value);
			if (typeof path === "string") {
				checkPath(check, mode, path);
				return true;
			}
			if (granted(unwrap(value), mode)) return true;
			if (!(unwrap(value) instanceof Blob)) return false;
			// A file-backed handle whose path cannot be read cannot be decided, so it never receives bytes.
			if (mode === "write") check(() => ({ unsupported: true }));
			return true;
		};
		const source = (value) => {
			for (const part of Array.isArray(value) ? value : [value]) handle(part, "read");
		};
		const destination = (value) => {
			if (typeof value === "number") resources.use(value, "write");
			else if (!handle(value, "write")) checkPath(check, "write", value);
		};
		const native = (value) => (Array.isArray(value) ? value.map(unwrap) : unwrap(value));
		Object.assign(files, { source, destination, handle });
		const standIn = (file) => {
			const surface = {
				get name() {
					return nativePath.call(file);
				},
				get type() {
					return file.type;
				},
				get size() {
					return file.size;
				},
				get lastModified() {
					return file.lastModified;
				},
				exists: (...args) => proto.exists.apply(file, args),
				stat: (...args) => proto.stat.apply(file, args),
				slice: (...args) => standIn(proto.slice.apply(file, args)),
			};
			for (const name of [...READERS, ...WRITERS, "writer"]) {
				surface[name] = (...args) => proto[name].apply(file, args);
			}
			stand.set(surface, file);
			return surface;
		};
		for (const name of READERS) {
			replaceMethod(proto, name, (original) => function (...args) {
				source(this); // sink:bunfile-read
				return original.apply(unwrap(this), args);
			});
		}
		for (const name of WRITERS) {
			replaceMethod(proto, name, (original) => function (...args) {
				destination(this); // sink:bunfile-write
				if (name === "write") source(args[0]); // sink:bunfile-write-parts
				return original.apply(unwrap(this), name === "write" ? [native(args[0]), ...args.slice(1)] : args);
			});
		}
		replaceMethod(proto, "writer", (original) => function (...args) {
			destination(this); // sink:bunfile-writer
			const writer = original.apply(unwrap(this), args);
			resources.record(writer, pathOf(this), ["write"]);
			for (const name of ["write", "flush", "end"]) {
				replaceMethod(writer, name, (fn) => function (...parameters) {
					resources.use(this, "write");
					return fn.apply(this, parameters);
				});
			}
			return writer;
		});
		bun.file = function (path, ...args) {
			const file = originalFile.call(this, executionPath(path), ...args);
			if (typeof path === "number") return resources.record(file, path, ["read", "write"]);
			try {
				checkPath(check, "read", path); // sink:bun-file-mint
			} catch (error) {
				if (error?.code !== "cell_permission_denied") throw error;
				// A denied path yields a stand-in with no internal slots, so every native consumer
				// of a file handle refuses it instead of reading the file behind our back.
				return standIn(file);
			}
			return file;
		};
		replaceMethod(bun, "write", (original) => function (target, data, ...args) {
			destination(target); // sink:bun-write-destination
			source(data); // sink:bun-write-parts
			return original.call(this, executionPath(unwrap(target)), native(data), ...args);
		});
		replaceMethod(bun, "serve", (original) => function (options, ...args) {
			for (const map of [options?.routes, options?.static]) {
				for (const value of map === null || typeof map !== "object" ? [] : Object.values(map)) {
					source(value); // sink:bun-serve
				}
			}
			return original.call(this, options, ...args);
		});
		const buffer = process.getBuiltinModule("node:buffer");
		for (const name of ["Blob", "File", "Response", "Request"]) {
			const original = globalThis[name];
			const guarded = new Proxy(original, {
				construct(target, args, newTarget) {
					if (name === "Blob" || name === "File") source(args[0]);
					else source(name === "Response" ? args[0] : args[1]?.body);
					return Reflect.construct(target, args, newTarget);
				},
			});
			globalThis[name] = guarded;
			if (buffer[name] === original) buffer[name] = guarded;
			if (original.prototype.constructor === original) {
				Object.defineProperty(original.prototype, "constructor", { value: guarded });
			}
		}
		for (const name of ["append", "set"]) {
			replaceMethod(FormData.prototype, name, (original) => function (key, value, ...args) {
				source(value);
				return original.call(this, key, value, ...args);
			});
		}
	}
	if (bun?.Glob) {
		for (const name of ["scan", "scanSync"]) {
			replaceMethod(bun.Glob.prototype, name, (original) => function (options) {
				const cwd = typeof options === "string" ? options : (options?.cwd ?? process.cwd());
				checkPath(check, "ls", cwd);
				return original.call(
					this,
					typeof options === "string" ? executionPath(cwd) : { ...options, cwd: executionPath(cwd) },
				);
			});
		}
	}
	replaceMethod(bun, "mmap", (original) => function (path, options) {
		check(() => ({ granted: true, unsupported: options?.shared !== false }));
		checkPath(check, "read", path);
		return original.call(this, executionPath(path), options);
	});
	replaceMethod(globalThis, "fetch", (original) => function (input, ...args) {
		const href = input instanceof Request ? input.url : String(input);
		if (href.startsWith("file:")) checkPath(check, "read", new URL(href));
		files.source(args[0]?.body);
		return original.call(this, input, ...args);
	});
	return files;
}
