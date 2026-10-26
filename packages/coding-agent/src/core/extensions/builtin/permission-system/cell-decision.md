# Eval-cell permission decision entry

Part of #4309. This entry is host-side permission policy only. It does not install
kernel hooks or intercept cell operations.

`decideCellOperation(sessionManager, { tool, input, cwd })` accepts `bash`, `read`,
`write` and `ls` tool-shaped calls. It follows the live preset flag, uses the live
tool parser registry and decides each request pattern separately through
`PermissionService.dispatchDecision`. A deny returns the deciding permission,
pattern and settings layer. Ask and allow both pass without a prompt. Missing,
retired or failed permission authority denies the operation.

`cellEnforcementState(sessionManager)` returns `active`, `alive` and `epoch`.
Active means an explicit user deny matches a supported permission class.
Changes to the ordered user rules or preset increment the epoch only when a
supported deny exists before or after the reload.
`onCellEnforcementChange(sessionManager, callback)` subscribes to state changes
and returns an unsubscribe function.

`bashPermissionRequests(command, cwd)` exports the existing bash tool parse,
including its external-directory requests, without changing the targets.

Known limitation: reads performed by the runtime's native module resolver
(bare packages, tsconfig aliases, package.json #imports, symlinked packages) are
not covered by this work; tracked in #4380.
