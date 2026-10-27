<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-27 - Commit each round's structural value leaves as one segment (part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-content-store.ts`: `flushValues()` collects up to 128 resident structural leaves and commits them with one `flushLeaves(batch)`, so they land in one segment file. Before, it wrote one file per leaf. The `value_write` job now calls `flushValues()` instead of flushing a single leaf, so both entry points follow the same batching rule. A failed batch write still keeps every leaf of the batch resident and halts spilling.
- `packages/coding-agent/src/modes/rpc/compact-index-compactor.ts`: the selection loop drops pending keys before `bases.getMany`, so a round no longer reads index paths for keys it cannot select. The selected keys, their order, the touched-page rule and the 128-key cap are unchanged.

### Why

- RULING-47 gates the settled-terminal path ("one thousand joined messages", 30 s). On that flow each of the 32 compaction rounds created about 130 `value-*` files (3,127 in total), and it read 39,486 structural nodes. Batching cuts this to 102-107 creates (at most 3 per round, excluding segment rewrites), and skipping pending keys before lookup cuts the reads to about 9,000-9,250.

### Why an extension could not handle it

- Spool segment layout and index compaction sit below the RPC session state; no extension surface reaches them.

### Expected merge conflict zones

- `compact-content-store.ts` `scheduleSpill`/`flushValues`, and the compactor's selection loop. Rollout remains off.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Changed

- Commit each compact-recovery compaction round's structural value leaves as one segment file, and skip lookups for keys a round cannot select; rollout remains disabled (part of #4272).
