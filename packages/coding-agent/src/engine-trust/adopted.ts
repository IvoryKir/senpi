/**
 * The generation this process adopted, kept in memory because the adopting engine deletes the
 * marker from JS `process.env`. Every spawner that hands the generation on builds from this record,
 * never from `process.env` (omo#10762, design r13 5.4 and 5.5).
 */
import { buildTrustLaunchEnvironment } from "./launch-environment.ts";
import type { EngineTrustMarker } from "./marker.ts";

let adopted: EngineTrustMarker | undefined;

export function recordAdoptedEngineTrust(marker: EngineTrustMarker): void {
	adopted = marker;
}

export function adoptedEngineTrust(): EngineTrustMarker | undefined {
	return adopted;
}

/**
 * The entries a daemon or handover successor is forced to receive: the generation, a marker with
 * an empty `restore` (a daemon's allowlist must not be bypassed by restored values) and no hop
 * (a hand-off may still make one trust exec of its own).
 */
export function engineTrustHandOffEnvironment(
	marker: EngineTrustMarker,
	platform: NodeJS.Platform,
): Record<string, string> {
	return buildTrustLaunchEnvironment({}, { marker: { ...marker, restore: {} }, hop: false, platform });
}
