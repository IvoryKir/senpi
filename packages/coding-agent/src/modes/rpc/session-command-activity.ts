import { RPC_ACTIVITY_NEUTRAL_METHODS } from "./rpc-method-class.ts";

/**
 * Whether the command itself refreshes activity, apart from attached-client keepalives. Reads leave it untouched: the
 * method table decides which (`RPC_ACTIVITY_NEUTRAL_METHODS`, senpi#4324).
 */
export function refreshesSessionActivity(command: string): boolean {
	return !(RPC_ACTIVITY_NEUTRAL_METHODS as ReadonlySet<string>).has(command);
}
