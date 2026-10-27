import type { OperationRow } from "./permission-operation-fs.ts";

// Every way a cell can hold a file-backed handle for the row's path. The decision is keyed by the
// handle's intrinsic path, so a copy that lost object identity is still the same file (#4391).
const origins = [
	["native", "Bun.file(p)"],
	["fetch-minted", "await (await Bun.fetch('file://'+p)).blob()"],
	["cloned fetch-minted", "structuredClone(await (await Bun.fetch('file://'+p)).blob())"],
	["name-overridden", "Object.defineProperty(Bun.file(p),'name',{value:q,configurable:true})"],
] as const;

const writeSinks = [
	["Bun.write(destination)", "const result=await Bun.write(handle,'changed');", "number"],
	["BunFile.write", "const result=await handle.write('changed');", "number"],
	["BunFile.writer", "const w=handle.writer();w.write('changed');const result=await w.end();", "number"],
	["Bun.spawn(stdout)", "const result=await Bun.spawn({cmd:['/bin/echo','spawned'],stdout:handle}).exited;", "number"],
	["Bun.spawn(stderr)", "const result=await Bun.spawn({cmd:['/bin/echo','spawned'],stderr:handle}).exited;", "number"],
	[
		"Bun.spawnSync(stdout)",
		"const result=Bun.spawnSync({cmd:['/bin/echo','spawned'],stdout:handle}).exitCode;",
		"number",
	],
] as const;

const readSinks = [
	[
		"Bun.spawn(stdin)",
		"const p2=Bun.spawn({cmd:['/bin/cat'],stdin:handle,stdout:'pipe'});const result=await new Response(p2.stdout).text();",
	],
	["Bun.write(parts array)", "await Bun.write(q,[handle]);const result=fs.readFileSync(q,'utf8');"],
	["BunFile.write(parts array)", "await Bun.file(q).write([handle]);const result=fs.readFileSync(q,'utf8');"],
	[
		"Bun.serve(routes)",
		"let result;const s=Bun.serve({port:0,routes:{'/f':handle}});try{result=await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}",
	],
	[
		"Bun.serve(static)",
		"let result;const s=Bun.serve({port:0,static:{'/f':handle},fetch(){return new Response('miss');}});try{result=await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}",
	],
] as const;

export const sinkOperations: readonly OperationRow[] = [
	...writeSinks.flatMap(([sink, code, shape]) =>
		origins.map(([origin, mint]): OperationRow => ({
			api: `${sink} via ${origin}`,
			tool: "write",
			shape,
			code: `const handle=${mint};${code}`,
		})),
	),
	...readSinks.flatMap(([sink, code]) =>
		origins
			// A fetch-minted handle is the documented read residual; it is proven at the write sinks only.
			.filter(([origin]) => origin !== "fetch-minted")
			.map(([origin, mint]): OperationRow => ({
				api: `${sink} via ${origin}`,
				tool: "read",
				shape: "string",
				code: `const handle=${mint};${code}if(result!=='{}')throw new Error('wrong file content: '+result);`,
			})),
	),
];

// Controls: with the row path read-denied, everything below must still behave exactly as before.
export const sinkControls = [
	{
		api: "allowed path keeps the native handle",
		code: "const a=q+'-native';fs.writeFileSync(a,'{}');const f=Bun.file(a);return JSON.stringify([f instanceof Blob,Object.getPrototypeOf(f)===Object.getPrototypeOf(new Blob([])),typeof f.slice(0,1).text==='function']);",
		expected: "[true,true,true]",
	},
	{
		api: "allowed path keeps native consumers",
		code: "const a=q+'-consumers';fs.writeFileSync(a,'{}');const f=Bun.file(a);const s=Bun.serve({port:0,routes:{'/f':f}});try{return JSON.stringify([await new Response(f).text(),await structuredClone(f).text(),await (await fetch(new URL('/f',s.url))).text(),await new Response(Bun.spawn({cmd:['/bin/cat'],stdin:f,stdout:'pipe'}).stdout).text()]);}finally{s.stop(true);}",
		expected: '["{}","{}","{}","{}"]',
	},
	{
		api: "allowed path keeps postMessage transport",
		code: "const a=q+'-port';fs.writeFileSync(a,'{}');const {port1,port2}=new MessageChannel();try{const received=new Promise(resolve=>{port2.onmessage=event=>resolve(event.data);});port1.postMessage(Bun.file(a));return await (await received).text();}finally{port1.close();port2.close();}",
		expected: "{}",
	},
	{
		api: "read-denied handle still writes through an allowed sink",
		code: "return String(await Bun.write(Bun.file(p),'written'));",
		expected: "7",
	},
	{
		api: "memory File named like a path is never refused",
		code: "return await new File(['{}'],'memory-named').text();",
		expected: "{}",
	},
];
