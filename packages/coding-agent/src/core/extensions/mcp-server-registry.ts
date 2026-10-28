import type { RegisteredMcpServer, RegisteredMcpServerDeclaration } from "./types.ts";

/**
 * MCP servers registered by the extensions of one runtime (`pi.registerMcpServer()`), in registration
 * order. The core only stores them; the built-in MCP gateway or an extension handling
 * `mcp_servers_change` connects them.
 */
export class McpServerRegistry {
	readonly #servers = new Map<string, RegisteredMcpServerDeclaration>();
	#changeListener: (() => void) | undefined;

	/** Register or replace the caller's own server. A name another extension registered first is kept (first wins). */
	register(server: RegisteredMcpServerDeclaration): void {
		const existing = this.#servers.get(server.name);
		if (existing !== undefined && existing.extensionPath !== server.extensionPath) {
			console.warn(
				`MCP server '${server.name}' declared by both ${existing.extensionPath} and ${server.extensionPath}; keeping first declaration from ${existing.extensionPath}.`,
			);
			return;
		}
		this.#servers.set(server.name, server);
		this.#changeListener?.();
	}

	/** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
	unregister(name: string, extensionPath: string): void {
		if (this.#servers.get(name)?.extensionPath !== extensionPath) return;
		this.#servers.delete(name);
		this.#changeListener?.();
	}

	/** The stored declarations, for the built-in gateway. */
	declarations(): readonly RegisteredMcpServerDeclaration[] {
		return [...this.#servers.values()];
	}

	/** Copies of the registered servers in upstream's `RegisteredMcpServer` shape, for extensions. */
	list(): RegisteredMcpServer[] {
		return [...this.#servers.values()].map(({ name, config, extensionPath }) => ({
			name,
			config: structuredClone(config),
			extensionPath,
		}));
	}

	/** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.#changeListener = listener;
	}
}
