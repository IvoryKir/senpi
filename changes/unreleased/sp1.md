<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-27 - One segment file per compaction round (part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-paged-tree.ts`: a round's `flush` (which since #4398 writes only the nodes that survive the round) now writes them all into one segment file.
- `packages/coding-agent/src/modes/rpc/compact-segment-storage.ts` (new): segment bookkeeping. A flush batch becomes one spool file and each leaf is read back by its offset. A segment is deleted when its last live leaf is released and no read of it is in flight. When its live bytes fall below half its size, it is rewritten once into a new segment: the new file is written first, then the live leaves' slots move to it, so they stay committed throughout. Dead bytes on disk therefore stay at most the live bytes of the segments that hold them.
- `packages/coding-agent/src/modes/rpc/compact-content-store.ts`: `flushLeaves` writes a batch of resident leaves as one segment; `flushLeaf` is a batch of one. A failed segment write keeps every leaf of the batch resident and spillable and halts spilling, as a failed single-leaf write did.
- `packages/coding-agent/src/modes/rpc/compact-storage-io.ts` and `compact-spool-storage.ts`: `CompactStorageIo.readFile` takes an optional byte range, and leaf reads pass one; page reads still read whole files.

### Why

- RULING-47 budgets the 8,192-row bulk fold at 3 file creates per round (one segment, one page, one owner marker) and deletes at most creates. One file per surviving node made 9,082 creates and 762 deletes for that fold; it now makes 192 creates and 0 deletes.

### Why an extension could not handle it

- Spool file layout and leaf ownership sit below the RPC session state; no extension surface reaches them.

### Expected merge conflict zones

- `compact-content-store.ts` flush and read paths, and `CompactStorageIo` implementations (test doubles must forward the range). Rollout remains off.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Changed

- Write each compact-recovery index compaction round as one segment file holding only its surviving nodes, with bounded reclamation of partly dead segments; rollout remains disabled (part of #4272).
