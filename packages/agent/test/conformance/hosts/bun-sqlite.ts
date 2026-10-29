// CONF.bun (senpi#4740): the Bun SQLite host. Every STORE-* and KILL-STORE-* case runs on a fresh medium of
// packages/session-backends/sqlite-bun through the exported StoreConformanceAdapter. Bun-only: it imports bun:sqlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqliteMedia } from "../../../../session-backends/sqlite-bun/src/index.ts";
import type { ConformanceHost } from "../../../src/conformance/runner.ts";
import type { StoreCaseAdapters } from "../../../src/durable/testing/store-harness.ts";

export function createBunSqliteHost(): ConformanceHost<StoreCaseAdapters> {
	const media = createBunSqliteMedia(mkdtempSync(join(tmpdir(), "conf-bun-sqlite-")));
	return { name: "bun-sqlite", provides: ["store"], adapters: { store: media } };
}
