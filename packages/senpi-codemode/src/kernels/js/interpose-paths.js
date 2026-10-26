const path = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

export function requestedPath(value) {
	if (value instanceof URL) return fileURLToPath(value);
	if (value instanceof Uint8Array) {
		const text = Buffer.from(value).toString();
		return Buffer.from(text).equals(value) ? text : undefined;
	}
	return typeof value === "string" ? value : undefined;
}

export function executionPath(value) {
	if (typeof value === "string") return path.resolve(process.cwd(), value);
	if (value instanceof Uint8Array && !path.isAbsolute(Buffer.from(value).toString("latin1"))) {
		return Buffer.concat([Buffer.from(process.cwd() + path.sep), value]);
	}
	return value;
}

export function checkPath(check, tool, value, cwd = process.cwd()) {
	try {
		check(() => {
			const requested = requestedPath(value);
			return { call: { tool, input: { path: requested }, cwd }, unsupported: requested === undefined };
		});
	} catch (error) {
		if (error?.code === "cell_permission_denied" && typeof value === "string") error.message += `: ${value}`;
		throw error;
	}
}

export function replaceMethod(owner, name, wrap) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const wrapped = wrap(original);
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype" || Object.hasOwn(wrapped, key)) continue;
		Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
	}
	Object.defineProperty(owner, name, {
		...(Object.getOwnPropertyDescriptor(owner, name) ?? { configurable: true, writable: true, enumerable: false }),
		value: wrapped,
	});
}
