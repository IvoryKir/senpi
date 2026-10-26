# Python kernel permissions

This is the Python portion of senpi#4309, stacked on the JavaScript permission
core and invoker-authority work. The integrating permission extension supplies
`PythonKernelStartOptions.permissions.state` and `decide`. This PR does not
replace the extension's rule matcher or connect configuration reload events.

## Transport and authority

Each cell and kernel-tool invocation receives a fresh host-minted token.
Python keeps that token in a `ContextVar`, including copied parallel contexts.
The host's existing invocation pump owns callback token lifetime; the existing
cross-session admission check runs before the callback body.

The existing loopback HTTP bridge serves `/permission_check`. This route uses
the invocation capability, not the owner's bridge bearer. Every operation opens
a new connection, sends a random nonce, and requires the same nonce in the reply.
Connect, send, and receive share one two-second deadline. Unknown tokens,
transport failures, invalid replies, host failures, cancellation, and revoked
tokens all refuse. The ordinary authenticated bridge routes are unchanged.
The shared `CellOperation` type adds `read` and `ls`; the JavaScript slot layout
and its state transitions are unchanged.

Python maps a host-owned authority file read-only. The host publishes each
epoch/alive/active word with one aligned eight-byte write, and never reuses a
token offset while its interpreter may retain a context. Wrapped operations
inspect the word before taking the inactive fast path and again after an allow.
No-token contexts consult the kernel word and cannot borrow an enforcing
invocation's authority.

`revokeSessionKernels` marks the words DEAD synchronously and cancels pending
checks before requesting retirement. Admission waits for the existing process
retirement path to observe exit. An abandoned retirement permanently fences
the host session and emits `onRevocationFailed`; the integrating extension must
also fence direct tools on that event.

## Runtime boundary

The prelude loads both permission modules by their own file locations before
user code, including when the prelude is loaded through `runpy`. Captured
originals, the descriptor grants, and the mapping stay in closures. Wrappers
do not publish `__wrapped__` references to originals.

File modes map to read, write, or both. Descriptor grants record paths and
modes; unknown descriptors and opposite-mode operations refuse. Retained file
objects check authority on use. SQLite connections compose their authorizer
with user authorizers, refuse ATTACH and extension loading, and separately
decide both backup endpoints.

Loader source and resource reads remain subject to read checks. The engine's
bytecode-cache writer is recognized by the original loader code objects in
its call chain, not by a runtime-directory prefix. Direct calls to `set_data`
still request write permission. Memory probes resolve before interposition and
keep their fixed engine I/O private. Under enforcement, exception formatting
reports the real traceback frames without issuing linecache source-file reads.

Ruby and Julia refuse each enforcing cell before posting it to the interpreter,
including queued cells whose policy changed before execution. Inactive cells
retain their existing execution path.

This is API interposition, not a sandbox against deliberate introspection or
already-loaded native code.

Known limitation: reads performed by the runtime's native module resolver (bare packages, tsconfig aliases, package.json #imports, symlinked packages) are not covered by this work; tracked in #4380.
