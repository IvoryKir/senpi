<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-27 - Build each changed index node once per compaction round (part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-paged-batch.ts` (new): a compaction round's sorted changes (an undefined value deletes) are merged into the paged AVL in one descent. Changed nodes are plain RAM drafts, rebalanced with AVL join (one rotation per level), and the result is made bottom-up once, so every node of the new tree is built, owned (`text.own`) and registered for commit exactly once, and a node replaced inside the round is never built.
- `packages/coding-agent/src/modes/rpc/compact-paged-tree.ts`: `apply(root, changes)` replaces the per-key path-copying `set` and its `balance`.
- `packages/coding-agent/src/modes/rpc/compact-index-compactor.ts`: a round collects its page assignments and removals into one change map and applies it once; the new pages' owners stay held until the apply settles.
- `packages/coding-agent/src/modes/rpc/compact-segment-storage.ts` (SP1 review LOWs): a segment rewrite reads only its live byte ranges, one range read per adjacent run, and counts the bytes it holds in `pendingIoCopyBytes` until it ends; `retire()` during the rewrite's read ends the rewrite without recording a `reclaim` failure.

### Why

- RULING-47 budgets paged-node allocations at 1.5x the nodes that survive their round for the 8,192-row bulk fold. Copying one root path per key made 114,675 allocations for 8,954 survivors; the fold now allocates 8,891, all of them survivors, which removes the allocation-driven in-memory gap.
- The rewrite read the whole segment although less than half of it was live, and an orderly shutdown during that read left a spurious failure in `status().failures`.

### Why an extension could not handle it

- The paged index tree and spool segments sit below the RPC session state; no extension surface reaches them.

### Expected merge conflict zones

- `compact-paged-tree.ts` (the removed `set`/`balance`) and the compactor's publication loop. Rollout remains off.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Changed

- Build each changed compact-recovery index node once per compaction round instead of copying a path per key, and make a partly dead segment's rewrite read only its live bytes; rollout remains disabled (part of #4272).
