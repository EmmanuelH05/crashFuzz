# Target selection

> **Status: not written. Required before Phase 1.**

## Criteria

From `CLAUDE.md`, in priority order:

1. Makes an explicit, written durability guarantee that can be turned into an oracle
2. Postdates or was not covered by ALICE's 2014 target set
3. Small enough to build, instrument, and reason about in a week
4. Active maintainers who respond to issues (last 90 days)
5. Permissive license and a POSIX file API, with no custom block layer
6. **[Added]** Routes file I/O through libc. A Go or statically linked target cannot be
   observed by an `LD_PRELOAD` shim and would require a `ptrace`-based Phase 1. See
   `docs/EXECUTION-PLAN.md` §7.1.

Verification for criterion 6:

```bash
strace -f -c -e trace=write,pwrite64,fsync,fdatasync,rename <target-workload>
LD_PRELOAD=./shim/build/probe.so <target-workload>   # must observe the same calls
```

## Primary target

To be determined.

## Control target

SQLite, per `CLAUDE.md`. It is exhaustively tested and is expected to report no
violations. A reported bug in SQLite most likely indicates a defect in this tool.

## Candidates evaluated

| Candidate | Language | 1. Guarantee | 2. Post-ALICE | 3. Size | 4. Active | 5. License/API | 6. libc | Verdict |
|---|---|---|---|---|---|---|---|---|
| redb | Rust | | | | | | | |
| fjall | Rust | | | | | | | |
| bbolt | Go | | | | | | | |
| BadgerDB | Go | | | | | | | |
| DuckDB | C++ | | | | | | | |
| LMDB | C | | | | | | | |
| RocksDB | C++ | | | | | | | |
| LevelDB | C++ | | No — in ALICE's 2014 set | | | | | Rejected (criterion 2) |

## Rejected candidates

At least three are required by the Phase 0 gate. Each reason cites a criterion.
