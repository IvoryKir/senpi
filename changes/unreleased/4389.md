<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-10-26 - Persistent active component roots and producer identity (part of #4272)

### What changed

- `packages/coding-agent/src/modes/rpc/compact-session-state.ts` transfers persistent block roots during freeze and settlement, retaining exact settled membership.
- `packages/coding-agent/src/modes/rpc/compact-component-roots.ts` projects changed AVL paths into bounded spillable nodes and reclaims detached hot headers outside acceptance.
- `packages/coding-agent/src/modes/rpc/compact-active-block.ts` preserves the existing text append and replay validation.
- `packages/coding-agent/src/modes/rpc/compact-start-identity.ts` validates mandatory producer identity, a per-epoch high-water mark, and a 64-retirement epoch window.
- `packages/coding-agent/src/modes/rpc/compact-transition.ts` requires epoch and ordinal on starts and exposes typed missing/invalid and duplicate/stale rejections.

### Why

- S03b-1b-II-a removes active collection freeze and settle walks while preventing stale starts before the later cold-membership migration. Selection remains off.

### Why an extension could not handle it

- Storage ownership and synchronous acceptance are internal RPC consumer responsibilities below extension delivery.

### Expected merge conflict zones

- Compact consumer transitions and storage accounting. The codec and settled-index internals are unchanged; II-b owns cold-key paging and ordered cold operations.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Changed
- The staged compact recovery consumer retains persistent active roots and rejects missing, duplicate, and stale producer start identities (part of #4272).
