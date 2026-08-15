# Coverage

> **Status: not written. Required by the Phase 4 gate.**
>
> What was not tested, and why. Written as gaps are identified rather than assembled at
> the end.

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

## Write-path coverage

Phase 4: build the target with coverage instrumentation and report which write-path
functions were exercised and which were not.

## Sweep completeness

| Axis | Value | Run | Notes |
|---|---|---|---|
| Filesystem | ext4 `data=ordered` | [ ] | |
| Filesystem | ext4 `data=journal` | [ ] | |
| Filesystem | xfs | [ ] | |
| Filesystem | btrfs | [ ] | |
| Workload | single-writer | [ ] | |
| Workload | concurrent writers | [ ] | |
| Workload | large values | [ ] | |
| Workload | many small transactions | [ ] | |
| Workload | rename-based update protocol | [ ] | |
