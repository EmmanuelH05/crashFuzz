# Target selection

Decided 2026-08-15. Primary: **redb**. Control: **SQLite**.

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

Result of that verification is recorded under "Criterion 6 verification" below.

## Primary target: redb

<https://github.com/cberner/redb> — Rust, Apache-2.0, 4.7k stars, ~32k lines of Rust
under `src/`, single-file database, copy-on-write B-tree with a two-slot commit header.

**1. Durability guarantee.** `redb::Durability` has exactly two variants and the doc comment
on `Immediate` is the whole contract:

> `Immediate`: Commits with this durability level are guaranteed to be persistent as soon
> as `WriteTransaction::commit` returns.
>
> `None`: Commits with this durability level will not be persisted to disk unless followed
> by a commit with `Durability::Immediate`.
>
> — `src/transactions.rs:370-379` at commit `cff6e50`

The README additionally claims "Fully ACID-compliant transactions". One sentence, two
levels, no ambiguity about which calls are covered — this mechanizes directly into the
oracle in `docs/EXECUTION-PLAN.md` §4 with no per-workload checker. `Durability::None`
gives us a built-in negative control: operations committed at that level carry no
expectation, so a workload mixing both levels exercises the oracle's ability to
distinguish acknowledged-durable from merely returned.

**2. Post-ALICE.** redb's first release is 2022; ALICE's set is from 2014. Pathfinder's
POSIX set is LevelDB, RocksDB, WiredTiger. redb appears in none of them.

**3. Size.** 31,870 lines of Rust in `src/`, one crate, no C dependencies, `cargo build`
with no system libraries beyond libc. Buildable and readable inside the budget.

**4. Maintainer activity.** 100+ commits in the 90 days before 2026-08-15. Issues opened in
the last 48 hours have maintainer replies; issue #1099 (a feature request) was answered and
closed on 2026-08-14. Single primary maintainer (Christopher Berner), which is a
responsiveness strength and a bus-factor risk for the disclosure phase.

**5. License and API.** Apache-2.0. Plain file I/O through a `StorageBackend` trait; the
default Unix backend is `FileBackend` in `src/tree_store/page_store/file_backend/optimized.rs`,
which is `pwrite`/`pread`/`ftruncate`/`fdatasync` and nothing else. No custom block layer,
no `O_DIRECT`, no `io_uring`.

**6. libc.** Rust `std::fs` — `FileExt::write_all_at` → `pwrite64`, `File::sync_data` →
`fdatasync`, `File::set_len` → `ftruncate`. All go through libc and are interposable.
Critically, **no mmap**: the backend reads and writes with explicit syscalls, so the
unobservable-window risk in `docs/EXECUTION-PLAN.md` §7.2 does not apply to this target.

**Why redb over fjall (the runner-up).** fjall meets every criterion too — Apache-2.0, active
(issues answered same-day on 2026-08-15), and its `PersistMode` enum documents `Buffer`,
`SyncData` and `SyncAll` with an explicit statement that `Buffer` is *not* durable across
power loss (`src/journal/writer.rs:33-50`). Two things decided it. First, size and shape:
fjall is ~12.6k lines but its storage layer lives in the separate `lsm-tree` and `value-log`
crates, so the code under test is spread across three repositories and three issue trackers,
which complicates both criterion 3 and Phase 5 disclosure. Second, on-disk footprint: an LSM
engine writes many files across compaction, which multiplies the crash-state space per
workload at Phase 2, whereas redb's single file with a fixed-size header is the smallest
surface that still has a real update protocol. fjall is retained as the first alternative if
redb comes back clean.

**Known risk: redb has existing crash-testing investment, but less than it appears.** Its
test suite has `tests/crash_consistency.rs`, a regression test for a real bug in which a
header write persisted without the file extension. That is one hand-constructed crash image
for one known bug, not a search. The fuzzer (`fuzz/fuzz_targets/fuzz_redb.rs`) injects I/O
*errors* on a countdown and then reopens; its `sync_data` is a no-op with the comment "the
fuzzer doesn't test crashes, so fsync is unnecessary" (`fuzz_redb.rs:88-92`), and every
write lands in the real file immediately. **redb therefore has no existing test that explores
reordering or loss of unpersisted writes** — which is precisely the space crashfuzz
enumerates. This is the strongest single argument for the target and it is falsifiable: if a
reader finds such a test, the argument fails.

Expected yield is still low. redb is written by an author who thinks about this, and the
prior on any given mature engine is clean. `CLAUDE.md` requires that outcome to be reported
as a partial result rather than dressed up.

## Control target: SQLite

Per `CLAUDE.md`. Exhaustively tested, studied by ALICE in 2014, and expected to report zero
violations. A violation reported against SQLite indicates a defect in crashfuzz, not in
SQLite, and is treated as a broken oracle. Configuration is pinned in `docs/model.md`
because SQLite's guarantees depend on `journal_mode` and `synchronous`; at
`synchronous=NORMAL` in WAL mode SQLite documents that recently committed transactions may
be lost after a power failure, which would look like a violation and would be correct
behavior.

## Candidates evaluated

| Candidate | Language | 1. Guarantee | 2. Post-ALICE | 3. Size | 4. Active | 5. License/API | 6. libc | Verdict |
|---|---|---|---|---|---|---|---|---|
| redb | Rust | Yes — `Durability::Immediate` | Yes (2022) | 32k LOC, 1 crate | 100+ commits/90d | Apache-2.0, pwrite/fdatasync | Yes, no mmap | **Primary** |
| fjall | Rust | Yes — `PersistMode` | Yes (2024) | 12.6k + 2 crates | same-day issue replies | Apache-2.0, file I/O | Yes | Runner-up |
| bbolt | Go | Yes | Yes (fork 2017) | Small | Active | MIT | **No** | Rejected (6) |
| BadgerDB | Go | Yes — `SyncWrites` | Yes | Large | Active | Apache-2.0 | **No** | Rejected (6) |
| DuckDB | C++ | Yes — WAL docs | Yes | ~496 MB repo | Active | MIT | Yes | Rejected (3) |
| LMDB | C | Yes | No — in ALICE's set | Small | Active | OpenLDAP | Yes, but **mmap writes** | Rejected (2, 5) |
| RocksDB | C++ | Yes | Partly | ~248 MB repo | Active | GPL-2.0/Apache-2.0 | Yes | Rejected (2, 3) |
| LevelDB | C++ | — | No — in ALICE's set | Small | Low | BSD-3 | Yes | Rejected (2) |
| SQLite | C | Yes | No — in ALICE's set | Large | Active | Public domain | Yes | Control only |

## Rejected candidates

1. **bbolt (criterion 6).** Go. The Go runtime issues syscalls directly rather than through
   libc, so an `LD_PRELOAD` interposer observes no file I/O from the binary. Selecting it
   would force Phase 1's primary mechanism to be `ptrace`, a different and substantially
   slower implementation. bbolt is otherwise an excellent target — explicit fsync discipline,
   used by etcd — and is the best argument for building the `ptrace` path later.

2. **BadgerDB (criterion 6).** Same reason as bbolt, plus a larger codebase.

3. **LMDB (criteria 2 and 5).** In ALICE's 2014 set, so it fails criterion 2 outright. It
   also writes through a `MAP_SHARED` mmap, and stores to a mapped region are invisible to
   an `LD_PRELOAD` shim until `msync` — see `docs/EXECUTION-PLAN.md` §7.2 and the entry
   already in `docs/coverage.md`. The write path we most want to observe is the one we
   cannot see.

4. **DuckDB (criterion 3).** A ~496 MB repository with a full analytical engine attached to
   the storage layer. Not buildable, instrumentable and reasonable-about within a week, and
   the state-space cost of its multi-file storage would land in Phase 2.

5. **RocksDB (criteria 2 and 3).** Large, and already covered by Pathfinder's POSIX set. A
   finding here would compete directly with published work using a weaker method.

6. **LevelDB (criterion 2).** In ALICE's 2014 set, in two versions, and in Pathfinder's set.

## Criterion 6 verification

Required by the Phase 0 exit criteria: the primary target's syscall path must be confirmed
empirically before Phase 1 begins, with both `strace -f -c` and an `LD_PRELOAD` probe
observing the same calls.

Run 2026-08-15 in the Lima VM with `shim/src/probe.c` (built as `shim/build/probe.so`) and
the workload in `targets/redb-probe/`:

| Call | `strace -f -c` | `probe.so` |
|---|---|---|
| `pwrite64` | 74 | 74 |
| `fdatasync` | 14 | 14 |
| `ftruncate` | 3 | 3 |
| `write` | 1 | 1 |
| `mmap` with `MAP_SHARED` on a file | 0 | 0 |

redb passes: every call `strace` attributes to it is visible to the interposer, and it makes
no shared file mapping, so there is no unobservable write window. Full output and the two
probe defects this verification exposed are in `docs/journal.md`, Phase 0 entry.

SQLite, run the same way, also passes but does map its WAL `-shm` file `MAP_SHARED`. That
region is not part of the durability contract under test — SQLite documents `-shm` as
transient state rebuilt during recovery — but it is a write path the shim cannot see, and it
is recorded in `docs/coverage.md`.
