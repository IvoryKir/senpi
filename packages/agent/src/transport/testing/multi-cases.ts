import type { CaseImplementation } from "../../conformance/runner.ts";
import { createCarrierFault, type FaultStats } from "./fault-transport.ts";
import { allDelivered, expectExactDelivery, openLink, range, type TransportCaseAdapters } from "./transport-harness.ts";

type MultiCase = CaseImplementation<TransportCaseAdapters>;

const manyLanes: MultiCase = async (adapters) => {
	const link = openLink(adapters);
	const lanes = range(1, 8).map((n) => `scope-${n}`);
	const counts = Object.fromEntries(lanes.map((lane) => [lane, 25]));
	const sends = range(1, 25).flatMap((n) => lanes.map((lane) => link.send(lane, n)));
	await link.runUntil(allDelivered(link, counts), "MULTI-LANE-01 every scope delivered");
	await link.awaitAll(sends, "MULTI-LANE-01");
	await link.advance(1000);
	expectExactDelivery(link, counts, "MULTI-LANE-01");
	const lanesInLog = link.log.map((entry) => entry.slice(0, entry.indexOf(":")));
	for (const lane of lanes) {
		const first = lanesInLog.indexOf(lane);
		const lastOfOthers = Math.min(
			...lanes.filter((other) => other !== lane).map((other) => lanesInLog.lastIndexOf(other)),
		);
		if (first > lastOfOthers) throw new Error(`MULTI-LANE-01: ${lane} started only after another scope had finished`);
	}
};

const stalledLaneDoesNotHoldOthers = async (adapters: TransportCaseAdapters): Promise<void> => {
	const link = openLink(adapters);
	const release = link.gate("A");
	const aSends = range(1, 100).map((n) => link.send("A", n));
	const bSends = range(1, 10).map((n) => link.send("B", n));
	await link.runUntil(
		allDelivered(link, { B: 10 }),
		"MULTI-FAIR-01 B delivered while A's receiver is stalled",
		20_000,
	);
	await link.awaitAll(bSends, "MULTI-FAIR-01 B");
	if (link.delivered("A").length > 0) throw new Error("MULTI-FAIR-01: A delivered through a stalled receiver");
	release();
	await link.runUntil(allDelivered(link, { A: 100 }), "MULTI-FAIR-01 A delivered after release");
	await link.awaitAll(aSends, "MULTI-FAIR-01 A");
	await link.advance(1000);
	expectExactDelivery(link, { A: 100, B: 10 }, "MULTI-FAIR-01 stalled lane");
};

const MAX_A_FRAMES_BEFORE_B = 4;

const longLaneDoesNotStarveAnother = async (adapters: TransportCaseAdapters): Promise<void> => {
	const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
	const link = openLink(adapters, createCarrierFault("slow", stats));
	const aSends = range(1, 300).map((n) => link.send("A", n));
	await link.runUntil(() => link.delivered("A").length >= 20, "MULTI-FAIR-01 A's long lane under way");
	const before = link.delivered("A").length;
	const bSend = link.send("B", 1);
	await link.runUntil(allDelivered(link, { B: 1 }), "MULTI-FAIR-01 B delivered behind A's long lane");
	const aheadOfB = link.delivered("A").length - before;
	if (aheadOfB > MAX_A_FRAMES_BEFORE_B) {
		throw new Error(
			`MULTI-FAIR-01: ${aheadOfB} of A's frames went ahead of B's one frame (at most ${MAX_A_FRAMES_BEFORE_B})`,
		);
	}
	await link.runUntil(allDelivered(link, { A: 300 }), "MULTI-FAIR-01 A's long lane delivered", 600_000);
	await link.awaitAll([...aSends, bSend], "MULTI-FAIR-01 long lane");
	await link.advance(1000);
	expectExactDelivery(link, { A: 300, B: 1 }, "MULTI-FAIR-01 long lane");
	if (stats.refused === 0) throw new Error("MULTI-FAIR-01: the slow carrier never pushed back");
};

const fairness: MultiCase = async (adapters) => {
	await stalledLaneDoesNotHoldOthers(adapters);
	await longLaneDoesNotStarveAnother(adapters);
};

export const MULTI_CASES: ReadonlyMap<string, MultiCase> = new Map([
	["MULTI-LANE-01", manyLanes],
	["MULTI-FAIR-01", fairness],
]);
