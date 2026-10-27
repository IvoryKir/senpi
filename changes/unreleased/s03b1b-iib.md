<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-27 - Ordered cold operations and paged settled keys (part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-cold-operations.ts`, `compact-session-state.ts`, and `compact-transition.ts`: settled status/removal use `applyCold`, an ordered asynchronous non-acceptance path with typed outcomes and at most 128 pending operations. Active acceptance stays synchronous; cold operations do not advance its sequence.
- `packages/coding-agent/src/modes/rpc/compact-content-index.ts`, `compact-index-compactor.ts`, and `compact-index-traversal.ts`: add leased point descriptor reads and discard resident page key arrays. Compaction reads paged keys on demand and keeps their ownership through stale-row publication. Exact resident membership remains unchanged.
- `packages/coding-agent/src/modes/rpc/compact-state-view.ts`: separate compatibility view assembly from acceptance.

### Why

- Cold status/removal must remain ordered while unrelated active blocks continue accepting updates. Page headers must not retain a second raw-key catalog.
- This is the ruling-independent half of S03b-1b-II-b. Replacing exact settled membership awaits the settled-key-reuse ruling.

### Why an extension could not handle it

- These internal owners control acceptance, frozen cuts, storage leases, and index publication below extension delivery.

### Expected merge conflict zones

- `compact-session-state.ts` acceptance dispatch, cut reading, and storage lifecycle; index page descriptors and compaction publication.
- Producer/lane integration, old-message editing, user deletion, compaction removal, and transcript branching remain S03b-2/3 work. Rollout remains off.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Changed

- Stage ordered cold status/removal and paged settled-key descriptors for compact recovery, retaining exact settled membership and the disabled rollout (part of #4272).
