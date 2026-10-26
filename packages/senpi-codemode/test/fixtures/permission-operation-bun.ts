import type { OperationRow } from "./permission-operation-fs.ts";

export const bunOperations: readonly OperationRow[] = [
	...["string", "URL", "BunFile"].map((kind): OperationRow => ({
		api: `Bun.write(${kind})`,
		tool: "write",
		seed: "missing",
		shape: "number",
		code: `const result=await Bun.write(${kind === "URL" ? "new URL('file://'+p)" : kind === "BunFile" ? "Bun.file(p)" : "p"},'changed');`,
	})),
	{
		api: "BunFile.write",
		tool: "write",
		seed: "missing",
		shape: "number",
		code: "const result=await Bun.file(p).write('changed');",
	},
	{
		api: "BunFile.writer",
		tool: "write",
		seed: "missing",
		shape: "number",
		code: "const w=Bun.file(p).writer();w.write('changed');const result=await w.end();",
	},
	...["delete", "unlink"].map((name): OperationRow => ({
		api: `BunFile.${name}`,
		tool: "write",
		shape: "undefined",
		code: `const result=await Bun.file(p).${name}();`,
	})),
	...["text", "json", "bytes", "arrayBuffer", "stream", "formData", "image"].flatMap((name) =>
		[false, true].map((slice): OperationRow => ({
			api: `BunFile${slice ? ".slice()" : ""}.${name}`,
			tool: "read",
			shape:
				name === "text"
					? "string"
					: name === "bytes"
						? "uint8array"
						: name === "arrayBuffer"
							? "arraybuffer"
							: name === "stream"
								? "string"
								: "object",
			code:
				name === "stream"
					? `const result=await new Response(Bun.file(p)${slice ? ".slice()" : ""}.stream()).text();`
					: name === "image"
						? `const result=Bun.file(p)${slice ? ".slice()" : ""}.image();`
						: `const result=await Bun.file(p${name === "formData" ? ",{type:'application/x-www-form-urlencoded'}" : ""})${slice ? ".slice()" : ""}.${name}();`,
		})),
	),
	{ api: "fetch(file)", tool: "read", shape: "string", code: "const result=await (await fetch('file://'+p)).text();" },
	{
		api: "Bun.Glob.scan",
		tool: "ls",
		seed: "directory",
		shape: "array",
		code: "const result=[];for await(const v of new Bun.Glob('*').scan({cwd:p})) result.push(v);",
	},
	{
		api: "Bun.Glob.scanSync",
		tool: "ls",
		seed: "directory",
		shape: "array",
		code: "const result=[...new Bun.Glob('*').scanSync({cwd:p})];",
	},
	{ api: "Bun.mmap(private)", tool: "read", shape: "uint8array", code: "const result=Bun.mmap(p,{shared:false});" },
	{
		api: "node:sqlite.DatabaseSync",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('node:sqlite').DatabaseSync)(p);result.close();",
	},
	{
		api: "bun:sqlite.Database",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('bun:sqlite').Database)(p);result.close();",
	},
	{
		api: "bun:sqlite.Database.open",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=require('bun:sqlite').Database.open(p);result.close();",
	},
	{
		api: "bun:sqlite.default",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('bun:sqlite').default)(p);result.close();",
	},
];
