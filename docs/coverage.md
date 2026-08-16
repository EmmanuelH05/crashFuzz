# Coverage

What was not tested, and why. Written as gaps were identified during Phases 1 through 4
rather than assembled at the end.

## Known gaps

- **Memory-mapped writes.** Stores to a `MAP_SHARED` region are not visible to the shim
  until `msync`, so targets that write through mmap have an unobservable window.
  Identified while designing Phase 1; disqualified LMDB as a primary-target candidate.
  See `docs/EXECUTION-PLAN.md` §5, Phase 1.

- **SQLite's WAL `-shm` file (control target only).** Verified 2026-08-15: `sqlite3` in WAL
  mode maps its `-shm` file `MAP_SHARED`, so stores into that region are invisible to the
  shim. SQLite documents `-shm` as transient state that recovery rebuilds, so it is outside
  the durability contract we check, but it is a write path we do not observe and the control
  result must be read with that in mind. redb, the primary target, makes no shared file
  mapping at all.

- **Targets that do not route file I/O through libc.** Go binaries and statically linked
  binaries issue syscalls directly, so the `LD_PRELOAD` shim observes nothing. bbolt and
  BadgerDB were rejected on this basis (`docs/target-selection.md`). No `ptrace` ingestion
  path is implemented, so this class of target is untested.

- **Descriptors at or above 1024, and vectored writes over 64 KiB.** The shim caps its
  descriptor table at 1024 entries, so a call on a higher descriptor is traced without a
  path, and a `writev` whose buffers exceed 64 KiB is recorded without a digest rather than
  with a partial one. Neither limit was reached by redb or SQLite in any run so far.

- **Traces containing a failed persistence call.** The persistence model assumes every
  intercepted call returned success. `fsync` error handling is a separate bug class
  (Rebello et al., ATC '20) and an explicit non-goal, so a trace with a non-zero `errno` on
  a persistence call leaves the model's domain and is rejected at ingest rather than
  analyzed.

- **States where two or more writes are torn at once.** `maxTornOpsPerState` in
  `core/src/enumerate/bounds.jsonc` is 1, so a state has at most one operation on disk as a
  partial prefix. Physically any number of unpersisted writes could be partial at the same
  time; enumerating that multiplies the per-crash-point count by roughly (sectors + 1) per
  operation in the window instead of 2. A bug reachable only through two simultaneously torn
  writes is not reachable by this tool. Argued in `docs/journal.md`, Phase 2 entry.

- **Crash points not adjacent to a persistence call, in workloads longer than
  `maxExhaustiveWorkloadOps`.** These are sampled at `nonFsyncSampleRate` (5%), so 95% of
  them are never enumerated. Justified by Mohan et al.'s finding that every bug they
  reproduced involved a crash right after a persistence point, but that is a statement about
  the bugs they found, not a proof about the ones they did not. The sample is seeded, so a
  wider sweep re-runs the same trace with a different seed rather than repeating this one.

- **Most states at any crash point that enumerates more than 24.** `maxStatesPerCrashPoint`
  in `core/src/enumerate/bounds.jsonc` caps how many states are materialized, because a
  state costs microseconds to enumerate and a filesystem creation, a loop device, two mounts
  and a target recovery to test. The first and last state of each crash point are always
  kept; the rest are a seeded sample. A different seed tests a different subset.

- **Everything after the crash point in a recovered image.** Recovery runs against the image
  and may write to it. The oracle reads the result once and does not check what recovery
  itself wrote, so a target that recovers correctly but corrupts the image on a second open
  would not be caught.

- **Every state at a crash point where nothing had been acknowledged yet.** The oracle
  returns no violation when no durable acknowledgement precedes the crash point, because
  nothing was promised there. Those states are still materialized and still opened, so a
  target that destroys an unrelated file or hangs would be caught, but a target that
  corrupts its own database before its first acknowledgement would not be reported.

- **redb's repair path, as a judgement.** `check_integrity` returning "failed but was
  repaired" is treated as recovery working, because redb documents that it recovers from
  unclean shutdowns automatically. Whether a repair silently discarded acknowledged data is
  checked by the value comparison instead. A repair that preserved every acknowledged value
  while corrupting something the workload never wrote would not be noticed.

- **Workload shapes the sweep does not contain.** The redb sweep runs single-writer, large
  values, many small values, mixed durability and four contending writers. It does not run
  deletions, range operations, table creation or drop, savepoints, compaction, reopening a
  database mid-workload, or multi-process access. A bug that needs any of those is out of
  reach, and the write path they exercise was never traced.

- **The rename-based update protocol on the primary target.** redb does not use one, so the
  sweep covers that idiom only through `targets/unsafe-kv`, which is a deliberately broken
  application rather than a real one.

## Write-path coverage

**Not measured, and this is the largest honest gap in the Phase 4 result.** The sweep
records which crash states were tested, not which parts of redb's write path produced them.
Nothing here builds redb with coverage instrumentation, so a claim that the sweep exercised
redb's write path rests on the shape of the syscall trace rather than on line coverage.

What the traces do show, per shape, is which calls redb issued: `pwrite`, `fsync`,
`fdatasync` and `ftruncate` on the database file, with no `rename`, no `link`, and no
directory operations. Any part of redb reached only through calls it never issued in these
workloads — the compaction path and the savepoint path are the obvious ones — was not
exercised at all.

## Sweep completeness

Run by `bun run campaign`; the current numbers are in `docs/results.md`.

| Axis | Value | Run | Notes |
|---|---|---|---|
| Filesystem | ext4 `data=ordered` | [x] | Default mount option, stated explicitly |
| Filesystem | ext4 `data=journal` | [x] | The one total-order model in the sweep |
| Filesystem | xfs | [x] | |
| Filesystem | btrfs | [x] | |
| Workload | single-writer | [x] | 4 KiB values |
| Workload | concurrent writers | [x] | Four threads contending for the write transaction |
| Workload | large values | [x] | 256 KiB, crossing page boundaries |
| Workload | many small transactions | [x] | 64 byte values |
| Workload | mixed durability | [x] | Alternates `Immediate` and `None`; the negative control |
| Workload | rename-based update protocol | [x] | `targets/unsafe-kv` only, not redb, which does not use one |
