<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-28 - Compaction round files bounded at 64 KiB behind one commit (fixes #4539, part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-segment-storage.ts`: `COMPACT_SEGMENT_BYTES` (65,536) bounds every segment file. `segmentRuns` splits sized entries, in order, into runs of at most that many bytes, and `writeSegments` writes a flush batch as one such run of files, returning each text's placement only once every file is durable; a write that fails or throws discards the files the run already wrote and returns undefined.
- `packages/coding-agent/src/modes/rpc/compact-content-store.ts`: `flushLeaves(ids, operation?)` writes its batch through `writeSegments` and publishes every leaf in one synchronous step after the last file's write resolved. That step is the batch's commit record: no leaf is committed and no segment is registered before it, and a failed write leaves every leaf of the batch resident and spillable as before.
- `packages/coding-agent/src/modes/rpc/compact-paged-tree.ts`: `flush()` commits a compaction round with `node_write`, so a round's node files carry the `node-` prefix instead of sharing `value-` with structural value batches.
- `packages/coding-agent/src/modes/rpc/compact-storage-io.ts` and `compact-spool-storage.ts`: the new `node_write` operation names its file prefix (`node`) and halts spilling on failure like `value_write`; the prefix and halting rules are tables instead of chained conditionals.

### Why

- One compaction round wrote every node it built into a single segment file, which grew with the settled row count (measured 400,418 / 678,472 / 970,364 bytes for one round of 128 spread keys over 1,024 / 8,192 / 65,536 rows) and so exceeded the 64 KiB page bound (senpi#4539, RULING-54, RULING-47 as amended). Every file now stays within the bound, a reader holds at most one bounded page per file read, and a round cut after any of its files leaves the previous state fully readable with its stray files reclaimed.

### Why an extension could not handle it

- The spool segments sit below the RPC session state; no extension surface reaches them.

### Expected merge conflict zones

- LOW: `compact-segment-storage.ts` with senpi#4521 (SP3), which adds the same `COMPACT_SEGMENT_BYTES` and `segmentRuns` for value batches; keep one copy. `flushLeaves` in `compact-content-store.ts`. Rollout remains off.
