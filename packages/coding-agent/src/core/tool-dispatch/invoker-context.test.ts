import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import { kernelToolInvokerStorage } from "../extensions/kernel-tools-context.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { createToolDispatcher } from "./tool-dispatcher.ts";

const manager = SessionManager.inMemory();
const contexts: Array<{ name: string; context: ExtensionToolContext | undefined; sessionId?: string }> = [
	{ name: "no context", context: undefined },
	{ name: "observer context", context: {} as ExtensionToolContext },
	{
		name: "child context without readable properties",
		context: new Proxy({} as ExtensionToolContext, {
			get: (_target, key) => {
				throw new Error(`unexpected context access: ${String(key)}`);
			},
		}),
	},
	{ name: "absent session manager", context: { sessionManager: undefined } as unknown as ExtensionToolContext },
	{
		name: "own session manager",
		context: { sessionManager: manager } as unknown as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
	{
		name: "inherited session manager",
		context: Object.create({ sessionManager: manager }) as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
	{
		name: "lazy session manager",
		context: {
			get sessionManager() {
				return manager;
			},
		} as unknown as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
];

// #4390 / #4309: dispatch may legitimately have no context. Such calls must use
// the kernel owner's authority, never a previous dispatch's ambient identity.
describe.each<ToolRuntimeKind>(["in-process", "child"])("invoker context (%s)", (runtime) => {
	describe.each([undefined, { sessionId: "outer-session" }])("with ambient invoker %j", (ambient) => {
		it.each(contexts)("binds only the available host identity: $name", async ({ context, sessionId }) => {
			const dispatcher = createToolDispatcher({ runtime });
			const notices: string[] = [];
			dispatcher.onDispatched((info) => notices.push(info.placement));
			const definition: ToolDefinition = {
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _update, receivedContext) => {
					expect(receivedContext).toBe(context);
					const before = kernelToolInvokerStorage.getStore();
					await Promise.resolve();
					expect(kernelToolInvokerStorage.getStore()).toEqual(before);
					return { content: [], details: before };
				},
			};
			const run = async () => {
				// Exercise the actual context-free wrapping path, not a fabricated
				// ToolDispatchCall with a falsely required context.
				const tool = wrapToolDefinition(definition, context ? () => context : undefined, dispatcher);
				const result = await tool.execute("probe", {});
				expect(result.details).toEqual(sessionId === undefined ? undefined : { sessionId });
				expect(kernelToolInvokerStorage.getStore()).toEqual(ambient);
				expect(notices).toEqual(["server"]);
			};
			if (ambient) await kernelToolInvokerStorage.run(ambient, run);
			else await run();
			expect(kernelToolInvokerStorage.getStore()).toBeUndefined();
		});
	});
});
