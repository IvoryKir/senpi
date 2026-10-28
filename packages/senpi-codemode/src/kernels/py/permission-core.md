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
An expired inactive token may continue ordinary background work only while the
kernel word remains alive and inactive. An expired enforcing token, or any dead
kernel word, still refuses. This keeps copied contexts and asyncio tasks working
across cells in sessions without deny rules.

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
Permission decisions use private copies of classification helpers, constants,
builtins, socket methods, and JSON codecs. Python helpers whose globals contain
dependencies get private globals dictionaries too. Rebinding public stdlib names
cannot change an authority word, forge a reply, or redirect a permission target.
The `posix`/`nt` aliases share the same wrappers as `os`.

Every path request carries two fields: `path`, the spelling as written, and
`executedPath`, the string the operating system receives (a relative spelling
joined onto the interpreter's current directory with `os.path.join`, never
collapsed or resolved in the interpreter). Python sends no canonical form:
`os.path.realpath` rebuilds a path from the request's own components and
differs from the native resolution on case and Unicode-form aliases, so the
host canonicalizes the executed path on its resolver worker, the same way it
does for every other request. A spelling that is not valid UTF-8 cannot travel
losslessly and is refused as uncheckable.

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
Engine permission assets are compiled directly from source without a bytecode
cache. Dynamic and builtin extension entry points, including `_imp`, are guarded.
Cells see live mapping/sequence views of import registries while enforcing:
ordinary reads continue, ordinary mutations carry the permission refusal, and
direct `dict`/`list` descriptors reject the views with `TypeError` before any
mutation. The `sys` dictionary view is read-only in that mode.
FileIO remains a subclassable raw-I/O adapter, but its MRO no longer exposes the
unguarded native file constructor.

Ruby and Julia refuse each enforcing cell before posting it to the interpreter,
including queued cells whose policy changed before execution. Inactive cells
retain their existing execution path.

This is API interposition, not a sandbox against deliberate introspection or
already-loaded native code.

Known limitation: reads performed by the runtime's native module resolver (bare packages, tsconfig aliases, package.json #imports, symlinked packages) are not covered by this work; tracked in #4380.
