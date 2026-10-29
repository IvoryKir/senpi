// senpi#4726: the suite runner, its host report, and the CONFORMANCE_HOST host run.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as conformanceExport from "../../src/conformance/index.ts";
import { buildManifest, type ConformanceManifest, findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { type CaseImplementation, type ConformanceHost, runSuite } from "../../src/conformance/runner.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);

interface FakeAdapters {
	readonly calls: string[];
}

const manifestCase = (id: string, adapters: ConformanceManifest["cases"][number]["adapters"]) => ({
	id,
	impl: "packages/agent/test/conformance/run-suite.test.ts",
	impl_hash: "f".repeat(64),
	intro: "#1",
	adapters,
	expected: "an expected outcome",
});

const manifest: ConformanceManifest = {
	suite_hash: "0".repeat(64),
	cases: [
		manifestCase("STORE-01", ["store"]),
		manifestCase("STORE-02", ["store"]),
		manifestCase("STORE-03", ["store"]),
		manifestCase("WAKE-01", ["store", "wake"]),
	],
};

const storeOnlyHost = (): ConformanceHost<FakeAdapters> => ({
	name: "fake",
	provides: ["store"],
	adapters: { calls: [] },
});

const implementations = new Map<string, CaseImplementation<FakeAdapters>>([
	["STORE-01", async (adapters) => void adapters.calls.push("STORE-01")],
	[
		"STORE-02",
		async () => {
			throw new Error("commit lost");
		},
	],
	["WAKE-01", async (adapters) => void adapters.calls.push("WAKE-01")],
]);

describe("runSuite", () => {
	it("reports pass, fail, a missing implementation and a missing adapter, in manifest order, never skipping", async () => {
		const host = storeOnlyHost();
		const report = await runSuite(manifest, host, implementations);

		expect(report).toEqual({
			host: "fake",
			suite_hash: manifest.suite_hash,
			results: [
				{ id: "STORE-01", status: "pass" },
				{ id: "STORE-02", status: "fail", error: "commit lost" },
				{ id: "STORE-03", status: "fail", error: "no implementation is registered for this case" },
				{ id: "WAKE-01", status: "fail", error: "the host does not provide adapter: wake" },
			],
		});
		expect(host.adapters.calls).toEqual(["STORE-01"]);
	});

	it("runs a case whose adapters the host provides", async () => {
		const host: ConformanceHost<FakeAdapters> = {
			name: "fake",
			provides: ["store", "wake"],
			adapters: { calls: [] },
		};
		const report = await runSuite({ ...manifest, cases: manifest.cases.slice(3) }, host, implementations);

		expect(report.results).toEqual([{ id: "WAKE-01", status: "pass" }]);
		expect(host.adapters.calls).toEqual(["WAKE-01"]);
	});
});

describe("findImplementationGaps", () => {
	it("names registered cases without an implementation and implementations without a registered case", () => {
		const extra = new Map(implementations).set("TRANSPORT-01", async () => {});
		expect(findImplementationGaps(manifest.cases, extra)).toEqual({
			unimplemented: ["STORE-03"],
			unregistered: ["TRANSPORT-01"],
		});
	});
});

describe("the ./conformance export", () => {
	it("is declared in package.json and re-exports the registry, manifest, suite hash and runner", async () => {
		const pkg: { exports: Record<string, unknown> } = JSON.parse(
			await readFile(`${PACKAGE_ROOT}package.json`, "utf8"),
		);

		expect(pkg.exports["./conformance"]).toEqual({
			types: "./dist/conformance/index.d.ts",
			import: "./dist/conformance/index.js",
		});
		expect(Object.keys(conformanceExport).sort()).toEqual([
			"ADAPTER_KINDS",
			"CONFORMANCE_REGISTRY",
			"buildManifest",
			"computeSuiteHash",
			"findImplementationGaps",
			"findMappingProblems",
			"runSuite",
			"sha256Hex",
		]);
	});
});

type HostFactory = () => Promise<ConformanceHost<unknown>>;

// Host adapters register here as they land; a named host that is not registered fails instead of skipping.
const HOSTS: Readonly<Record<string, HostFactory>> = {};
const HOST_IMPLEMENTATIONS = new Map<string, CaseImplementation<unknown>>();

function resolveHost(name: string, hosts: Readonly<Record<string, HostFactory>>): HostFactory {
	const factory = hosts[name];
	if (factory === undefined) {
		const known = Object.keys(hosts);
		throw new Error(
			`unknown conformance host "${name}"; registered hosts: ${known.length > 0 ? known.join(", ") : "(none)"}`,
		);
	}
	return factory;
}

describe("the CONFORMANCE_HOST host run", () => {
	it("fails for a host name with no registered adapter", () => {
		expect(() => resolveHost("bun-sqlite", HOSTS)).toThrow(
			'unknown conformance host "bun-sqlite"; registered hosts: (none)',
		);
	});

	const hostName = process.env.CONFORMANCE_HOST;
	if (hostName !== undefined) {
		it(`runs every registered case on ${hostName} and writes the report`, async () => {
			const host = await resolveHost(hostName, HOSTS)();
			const suite = await buildManifest(CONFORMANCE_REGISTRY, readRepoFile);
			const report = await runSuite(suite, host, HOST_IMPLEMENTATIONS);

			const manifestPath = process.env.CONFORMANCE_MANIFEST;
			if (manifestPath !== undefined) await writeFile(manifestPath, `${JSON.stringify(suite, null, "\t")}\n`);
			const reportPath = process.env.CONFORMANCE_REPORT;
			if (reportPath !== undefined) await writeFile(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
			expect(report.results.filter((result) => result.status !== "pass")).toEqual([]);
		});
	}
});
