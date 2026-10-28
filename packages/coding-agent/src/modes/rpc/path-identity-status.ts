import type { PathIdentityResolver } from "../../core/extensions/builtin/permission-system/path-identity-host.ts";

/** What `senpi host status` says about the path identity resolver: ready, or why its worker could not start. */
export interface PathIdentityResolverStatus {
	readonly state: "ready" | "unavailable";
	readonly detail: string | null;
}

export function pathIdentityResolverStatus(resolver: PathIdentityResolver): PathIdentityResolverStatus {
	const detail = resolver.unavailable;
	return detail === undefined ? { state: "ready", detail: null } : { state: "unavailable", detail };
}

export function parsePathIdentityResolverStatus(value: unknown): PathIdentityResolverStatus | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, detail } = value as { state?: unknown; detail?: unknown };
	if (state !== "ready" && state !== "unavailable") return undefined;
	return { state, detail: typeof detail === "string" ? detail : null };
}
