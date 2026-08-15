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

- **Traces containing a failed persistence call.** The persistence model assumes every
  intercepted call returned success. `fsync` error handling is a separate bug class
  (Rebello et al., ATC '20) and an explicit non-goal, so a trace with a non-zero `errno` on
  a persistence call leaves the model's domain and is rejected at ingest rather than
  analyzed.

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
