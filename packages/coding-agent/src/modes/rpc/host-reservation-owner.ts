/**
 * Who holds a published session-path claim, and whether that claim stands against a new open. Split out of
 * `host-reservations.ts`, which keeps the publishing side.
 */
import { readFile } from "node:fs/promises";
import {
	processIsRunning,
	processStartTimeMs,
	readProcessStartTime,
	sameProcessStartMs,
} from "../../utils/process-identity.ts";
import { generationPaths, type HostDaemonDirectory } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { generationHeartbeatStopped } from "./host-stalled-evidence.ts";
import { logUnknownHostIdentity } from "./host-supervisor-log.ts";

export interface SessionPathOwner {
	readonly instanceId: string;
	readonly host_socket?: string;
	readonly pid: number;
	readonly processStartTime: string | null;
	readonly sessionPath: string;
	/** Whether the owner had a client attached when it last published this claim. */
	readonly attached?: boolean;
	/**
	 * The owner hands the session over only by a strict transfer and removes this claim itself once the
	 * session is torn down (code-yeongyu/oh-my-openagent#10091): superseded and detached, it may still be
	 * running a turn in the file, so its claim stands for as long as its process does.
	 */
	readonly strict_transfer?: boolean;
	/** Whether the owner is the generation the pointer names. Answered on read, never stored. */
	readonly current?: boolean;
}

/**
 * `presumed_done`: the owner may still be alive (a frozen loop or a sleeping machine also stops the heartbeat), so the
 * takeover must fence it out of the session file first.
 */
export type ClaimVerdict =
	| { readonly kind: "stands"; readonly owner: SessionPathOwner }
	| { readonly kind: "released" }
	| { readonly kind: "presumed_done" };

/**
 * The claim that STANDS against a new open, or nothing when this path may be taken over.
 *
 * A claim is honored while its owner is the generation serving the socket, or while that owner
 * still has a client attached to the session - those are the two cases where somebody is really
 * writing the file. A superseded owner that published `attached: false` is draining (or should
 * be), so its claim is released rather than obeyed. A claim without the flag predates it and is
 * honored, so a running older generation is never reclaimed from. A strict-transfer owner's claim
 * stands while its process does: it releases the claim itself, once nothing can write the file.
 *
 * A superseded owner whose identity cannot be PROVEN - no start time was recorded, or none can be read
 * now - needs one more piece of evidence before it may block an open (#3652). On Windows a terminated
 * generation leaves its claim behind and the OS hands its pid to an unrelated process; without a
 * readable start time that stranger would hold the session file for as long as it runs. So such a
 * claim stands only while its generation still heartbeats: a heartbeat older than the stall-refusal
 * window is the same "died without cleaning up" verdict `hostLoopStalled` already reaches. A live
 * host whose probe is merely starved (#1609) keeps heartbeating and keeps its claim; a claim with no
 * heartbeat at all (an unsupervised or older host) keeps the previous benefit of the doubt.
 */
export async function standingOwner(owner: SessionPathOwner, paths: HostDaemonDirectory): Promise<ClaimVerdict> {
	const identity = await claimOwnerIdentity(owner);
	if (identity === "gone") return { kind: "released" };
	const current = (await currentInstanceId(paths.pointerFile)) === owner.instanceId;
	if (!current && identity === "unproven" && (await heartbeatStopped(paths, owner.instanceId)))
		return { kind: "presumed_done" };
	return current || owner.attached !== false || owner.strict_transfer === true
		? { kind: "stands", owner: { ...owner, current } }
		: { kind: "released" };
}

/** Whether the owner's generation left a heartbeat that is older than a stalled host could explain. */
async function heartbeatStopped(paths: HostDaemonDirectory, instanceId: string): Promise<boolean> {
	// A claim file is untrusted input: an instance id that is not a plain directory name names no generation.
	if (instanceId === "" || instanceId === "." || instanceId === ".." || /[\\/]/.test(instanceId)) return false;
	return generationHeartbeatStopped(generationPaths(paths, instanceId));
}

/** The generation the pointer names, or nothing when no pointer describes this endpoint. */
async function currentInstanceId(pointerFile: string): Promise<string | undefined> {
	const pointer = parseJson(await readFileOrUndefined(pointerFile).catch(() => undefined));
	return typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
}

export async function readOwner(file: string): Promise<SessionPathOwner | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		// Absent, unreadable or half-written: no claim that anyone could act on.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { instanceId, pid, processStartTime, sessionPath, attached, host_socket, strict_transfer } =
		parsed as Record<string, unknown>;
	if (typeof instanceId !== "string" || typeof pid !== "number" || typeof sessionPath !== "string") return undefined;
	return {
		instanceId,
		pid,
		processStartTime: typeof processStartTime === "string" ? processStartTime : null,
		sessionPath,
		...(typeof host_socket === "string" ? { host_socket } : {}),
		...(typeof attached === "boolean" ? { attached } : {}),
		...(strict_transfer === true ? { strict_transfer } : {}),
	};
}

/**
 * A claim counts only while the process that made it is still running. The recorded start time is
 * what separates "that host is still writing" from "the OS handed its pid to something else".
 */
export async function claimOwnerIsLive(owner: SessionPathOwner): Promise<boolean> {
	return (await claimOwnerIdentity(owner)) !== "gone";
}

/**
 * `proven`: the pid runs and its start time matches the claim. `gone`: the pid is dead, or runs with a
 * different start time. `unproven`: the pid runs but no start time was recorded or none can be read.
 */
export async function claimOwnerIdentity(owner: SessionPathOwner): Promise<"proven" | "gone" | "unproven"> {
	// An exited, unreaped owner (state Z) makes no more writes: the claim is gone (senpi#4119).
	if (!processIsRunning(owner.pid)) return "gone";
	const recorded = owner.processStartTime === null ? undefined : processStartTimeMs(owner.processStartTime);
	if (recorded === undefined) {
		logUnknownHostIdentity("session-path-claim", owner.pid);
		return "unproven";
	}
	const current = await readProcessStartTime(owner.pid).catch(() => undefined);
	const observed = current === undefined ? undefined : processStartTimeMs(current);
	if (observed === undefined) return "unproven";
	return sameProcessStartMs(recorded, observed) ? "proven" : "gone";
}
