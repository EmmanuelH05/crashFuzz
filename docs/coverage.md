# Coverage

> **Status: not written. Required by the Phase 4 gate.**
>
> What was not tested, and why. Written as gaps are identified rather than assembled at
> the end.

## Known gaps

- **Memory-mapped writes.** Stores to a `MAP_SHARED` region are not visible to the shim
  until `msync`, so targets that write through mmap have an unobservable window.
  Identified while designing Phase 1; may disqualify LMDB as the primary target.
  See `docs/EXECUTION-PLAN.md` §5, Phase 1.

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
