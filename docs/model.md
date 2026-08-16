# Correctness model

Every bug claim is only as strong as this document. Each decision below was argued in
`docs/journal.md` (entry "Model decisions for Phase 2") with the rejected reading recorded.

Sources: Pillai et al. (OSDI '14) for persistence properties, Mohan et al. (OSDI '18) for
filesystem guarantees above POSIX and for the bounding argument. Where a property would
require reading a specific cell of Pillai Table 1, it is marked unverified rather than
asserted, because the table's column headers do not survive text extraction unambiguously.

## Persistence model

A crash state is legal if it can be produced by applying some subset of the traced
operations, subject to the constraints below, to the state at the crash point.

| Property | ext4 `data=ordered` | ext4 `data=journal` | xfs | btrfs | Source |
|---|---|---|---|---|---|
| Single-sector overwrite is atomic | yes | yes | yes | yes | Pillai §2.2.1: "all tested file systems seemingly provide atomic single-sector overwrites" |
| Single-block (4 KiB) overwrite is atomic | no | yes | no | no | Pillai §2.2.1: atomic block overwrite "requires data journaling or copy-on-write" |
| Multi-block write or append is atomic | no | no | no | no | Pillai §2.2.1: "Current file systems do not provide atomic multi-block appends" |
| A large write persists as a prefix, not an arbitrary subset | yes | yes | yes | yes | Pillai §2.2.1: "most file systems seemingly guarantee that some prefix of the data written ... will be appended atomically" |
| Directory operations (`rename`, `link`, `unlink`) are atomic | yes | yes | yes | yes | Pillai §2.2.1: "seemingly atomic on all file systems that use techniques like journaling or copy-on-write" |
| All operations persist in program order | no | yes | no | no | Pillai §2.2.2: data journaling modes "persist all tested operations in order" |
| Append followed by `rename` of the same file is ordered | yes | yes | no | no | Pillai §2.2.2: the append-then-rename idiom is recognized and blocks are allocated immediately on delayed-allocation filesystems. Decision 1. |
| `fsync(fd)` on a new file also persists its directory entry | yes | yes | no | no | Mohan §2: "on ext4, persisting a new file will also persist its directory entry". Decision 3. |
| Directory operations on different directories may reorder | no | no | no | yes | Pillai §2.2.2 names ext2 and btrfs as the filesystems that "freely reorder directory operations". Nothing was found stating this for ext4 or xfs, so it is disabled there. A model that permits a reordering the filesystem does not perform produces false positives; one that forbids a reordering it does perform misses bugs, and `CLAUDE.md` prefers the second. |

Default mount option: ext4 `data=ordered`. `data=journal`, xfs and btrfs are swept in
Phase 4. Decision 4.

Each row is a flag in one filesystem module, so a crash state is only ever checked against
the filesystem it was enumerated for.

## Atomicity assumptions

- **Torn writes are modeled at 512-byte sector granularity, prefix-or-nothing.** A write
  of *n* sectors produces *n + 1* states: nothing, the first sector, the first two, and so
  on. Not the 2^*n* subsets. Decision 2.
- **Sub-sector tearing is not modeled.** No filesystem in the sweep is reported to tear
  below a sector, and the underlying device provides sector atomicity.
- **A returned `fsync` or `fdatasync` is a durability floor.** Everything written to that
  file before the call must be present in every state enumerated after it.
- **`fdatasync` does not persist metadata.** A size change that was not otherwise persisted
  may be absent in a state after `fdatasync` but present after `fsync`.

  **The enumerator does not implement this.** `core/src/enumerate/states.ts` pins every
  earlier mutation of a file on `fdatasync`, including size-changing ones, exactly as it does
  for `fsync`. The implementation is therefore stricter than this document: it enumerates
  fewer states than the model permits, and the states it omits are ones where a size change
  is absent after an `fdatasync`. That loses bugs rather than inventing them, which is the
  direction `CLAUDE.md` requires, but it is a divergence and it is load-bearing — redb
  commits with `fdatasync`, so closing it would enlarge the redb state space considerably.
  Recorded rather than fixed, because changing it is a persistence model change and
  `CLAUDE.md` requires both readings argued in `docs/journal.md` first.

- **A kept write persists together with its size effect.** The replayer applies a kept
  write through a real filesystem, so a write past EOF extends the materialized file. On
  ext4 the data and the size effect part ways: the data persists by writeback, while the
  size update is journaled metadata that jbd2 commits strictly after every earlier metadata
  change, including any dropped `ftruncate`'s. A state that drops an earlier size change
  therefore cannot legally carry a later one, and the materialized file can be longer than
  any length ext4 could leave. This over-approximation invented no finding against released
  redb — its open-path assert compares against the header's layout, which dwarfs either
  length — but it did make the fixed master reject an image whose strictly-legal variant it
  recovers, which is a false positive in miniature. Both readings are argued in the Phase 5
  journal entry. Divergence recorded rather than fixed for the same reason as the
  `fdatasync` one above.

## The oracle

Correct recovery, operationally:

> For crash point *k*, every logical operation acknowledged durable before *k* is readable
> after the target's own recovery with a matching value digest, and the target's own
> integrity check passes on the recovered database.

Acknowledgement comes from the workload driver's logical operation log, correlated to the
syscall stream by the marker channel described in `docs/trace-format.md`. A logical
operation is acknowledged durable when the target's documented durability contract has been
satisfied, not when the call returned.

Violation classes:

| Class | Fires when |
|---|---|
| `LOST_ACKED` | An operation acknowledged durable before the crash point is missing or has the wrong value after recovery |
| `CORRUPT_INVARIANT` | Recovery completed but the target's own integrity check fails |
| `RECOVERY_FAILED` | The target refuses to open, hangs, or crashes on a legal image |
| `PHANTOM_UNACKED` | Reserved. Fires only through the target's own integrity check; unacknowledged data present on disk is not itself a violation. Decision 5 |

`RECOVERY_FAILED` is the class most sensitive to the model being wrong, since it fires on
the legality of the image rather than on its contents. It is triaged separately in Phase 4.
Decision 6.

## Target configuration

Durability guarantees depend on target settings. Any setting left unpinned here can produce
violations that are correct behavior.

| Target | Setting | Value | Rationale |
|---|---|---|---|
| SQLite (control) | `journal_mode` | `WAL` | The mode most deployments use, and the one whose durability depends on `synchronous`. Pinned so the control's expected behavior is a single known contract. |
| SQLite (control) | `synchronous` | `FULL` | At `NORMAL` in WAL mode, SQLite documents that recently committed transactions may be lost after a power failure. |
| redb (primary) | `Durability` | `Immediate` for operations the oracle expects to survive; `None` for operations it must not expect | `Immediate` commits are documented as "guaranteed to be persistent as soon as `WriteTransaction::commit` returns" (`src/transactions.rs`). `None` carries no expectation and serves as an in-workload negative control. |

## Known-legal weirdness

Behaviors that resemble bugs but are permitted. Recorded so they are not re-investigated.

1. **SQLite at `synchronous=NORMAL` in WAL mode may lose recently committed transactions
   after a crash.** Documented and intended, which is why the control's settings are pinned
   above.
2. **redb commits at `Durability::None` may be absent after any crash, including crashes
   after later `Immediate` commits that did not follow them.** The documented contract is
   that a `None` commit becomes persistent only when followed by an `Immediate` commit; an
   operation that never had one is unconstrained.
3. **A file whose data is present but whose directory entry is missing is legal on xfs and
   btrfs after `fsync(fd)` without `fsync(dirfd)`.** It is not legal on ext4, per decision
   3. The same image is a violation on one filesystem and not on another, which is the
   reason states are materialized per filesystem.
4. **redb writes ahead of its acknowledgements.** Data from an uncommitted transaction on
   disk after a crash is expected and is not a violation unless the integrity check fails.

## What this model would miss

- Tearing below a sector, and non-prefix partial writes.
- Anything written through a `MAP_SHARED` mapping before `msync`. redb makes no such
  mapping; SQLite's WAL `-shm` file is one. See `docs/coverage.md`.
- Bugs that need more operations than the Phase 2 bound allows.
- Bugs that depend on filesystem state the workload did not create, since every run starts
  from a freshly made filesystem.
- Reorderings that ext4 or xfs do perform but that no source consulted states they perform.
  Every unverified property is disabled, which loses bugs rather than inventing them.
