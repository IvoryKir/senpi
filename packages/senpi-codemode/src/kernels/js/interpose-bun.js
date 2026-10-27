import { checkPath, executionPath, replaceMethod } from "./interpose-paths.js";

export function installBunPermissions(check, resources) {
	const bun = globalThis.Bun;
	const files = new WeakMap();
	const filePath = (file) => files.get(file);
	const decide = (file, mode) => {
		// BunFile and memory-backed Blob share a prototype; only tracked files do I/O.
		if (!files.has(file)) return;
		const target = filePath(file);
		if (typeof target === "number") resources.use(target, mode);
		else checkPath(check, mode, target);
	};
	const remember = (file, path) => {
		files.set(file, path);
		resources.record(file, path, ["read", "write"]);
		return file;
	};
	if (typeof bun?.file === "function") {
		const originalFile = bun.file;
		const proto = Object.getPrototypeOf(originalFile(new URL(import.meta.url)));
		for (const name of ["text", "json", "bytes", "arrayBuffer", "stream", "formData", "image"]) {
			replaceMethod(proto, name, (original) => function (...args) {
				decide(this, "read");
				return original.apply(this, args);
			});
		}
		for (const name of ["write", "delete", "unlink"]) {
			replaceMethod(proto, name, (original) => function (...args) {
				decide(this, "write");
				if (name === "write") decide(args[0], "read");
				return original.apply(this, args);
			});
		}
		replaceMethod(proto, "slice", (original) => function (...args) {
			const result = original.apply(this, args);
			return files.has(this) ? remember(result, filePath(this)) : result;
		});
		replaceMethod(proto, "writer", (original) => function (...args) {
			decide(this, "write");
			const writer = original.apply(this, args);
			resources.record(writer, filePath(this), ["write"]);
			for (const name of ["write", "flush", "end"]) replaceMethod(writer, name, (fn) => function (...parameters) {
				resources.use(this, "write");
				return fn.apply(this, parameters);
			});
			return writer;
		});
		bun.file = function (path, ...args) {
			return remember(originalFile.call(this, executionPath(path), ...args), path);
		};
		replaceMethod(bun, "write", (original) => function (target, ...args) {
			if (files.has(target)) decide(target, "write");
			else if (typeof target === "number") resources.use(target, "write");
			else checkPath(check, "write", target);
			decide(args[0], "read");
			return original.call(this, executionPath(target), ...args);
		});
		// Native consumers do not call Blob's JS methods. Authorize a file when it
		// enters a body/container, just like openAsBlob acquires its read grant.
		// Rules cannot change within that grant's lifetime without kernel retirement.
		const buffer = process.getBuiltinModule("node:buffer");
		for (const name of ["Blob", "File", "Response", "Request"]) {
			const original = globalThis[name];
			const guarded = new Proxy(original, {
				construct(target, args, newTarget) {
					if (name === "Blob" || name === "File") {
						if (Array.isArray(args[0])) {
							args[0] = args[0].map((part) => { decide(part, "read"); return part; });
						}
					} else {
						decide(name === "Response" ? args[0] : args[1]?.body, "read");
					}
					return Reflect.construct(target, args, newTarget);
				},
			});
			globalThis[name] = guarded;
			if (buffer[name] === original) buffer[name] = guarded;
			if (original.prototype.constructor === original) {
				Object.defineProperty(original.prototype, "constructor", { value: guarded });
			}
		}
		for (const name of ["append", "set"]) replaceMethod(FormData.prototype, name, (original) => function (key, value, ...args) {
			decide(value, "read");
			return original.call(this, key, value, ...args);
		});
	}
	if (bun?.Glob) {
		for (const name of ["scan", "scanSync"]) replaceMethod(bun.Glob.prototype, name, (original) => function (options) {
			const cwd = typeof options === "string" ? options : options?.cwd ?? process.cwd();
			checkPath(check, "ls", cwd);
			return original.call(this, typeof options === "string" ? executionPath(cwd) : { ...options, cwd: executionPath(cwd) });
		});
	}
	replaceMethod(bun, "mmap", (original) => function (path, options) {
		check(() => ({ granted: true, unsupported: options?.shared !== false }));
		checkPath(check, "read", path);
		return original.call(this, executionPath(path), options);
	});
	replaceMethod(globalThis, "fetch", (original) => function (input, ...args) {
		const href = input instanceof Request ? input.url : String(input);
		if (href.startsWith("file:")) checkPath(check, "read", new URL(href));
		decide(args[0]?.body, "read");
		return original.call(this, input, ...args);
	});
}
