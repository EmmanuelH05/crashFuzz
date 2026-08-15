# Journal

Record of what was tried, what failed, and what was learned. One entry per phase minimum,
plus an entry for each persistence-model decision. Written as work happens; it is the
source material for the Phase 6 write-up.

---

## 2026-08-13 — Scaffold

### Decisions

**Execution host: Lima VM (Ubuntu 24.04, aarch64).**

Alternatives considered:

- *Privileged Docker/OrbStack container.* Faster iteration and OrbStack is already
  installed, but containers share the host VM's kernel, which may not include xfs or btrfs
  modules. A missing module would reduce the Phase 4 sweep without failing any gate.
- *Cloud Linux instance.* Better suited to the Phase 4 campaign and provides an untouched
  machine for Phase 5 reproduction, at the cost of money and a slower edit loop.

Lima was chosen because the project measures filesystem persistence semantics, which
requires a kernel under our control. A fresh Lima instance also satisfies the Phase 5
clean-machine requirement. Revisit the cloud option if the campaign is too slow locally.

**Stack: C shim, TypeScript/Bun core, matplotlib figures.**

The `LD_PRELOAD` shim must be C because it is a shared object loaded into an arbitrary
target binary. For the orchestrator, Rust was considered: it suits the enumeration inner
loop and would ship a single static binary for the Phase 5 reproducer. The orchestrator's
work is I/O-bound (`mkfs`, `mount`, `fsync`, process spawn) rather than compute-bound, so
that advantage is small relative to the project convention of TypeScript on Bun.
matplotlib is used only for the two required figures.

**Process: GSD.**

`CLAUDE.md` already specifies gated phases with checkboxes and a rule against starting a
phase with an unchecked prior box. GSD's plan/execute/verify loop has the same structure,
so maintaining the gates manually would duplicate it.

### Issues identified during scaffolding

1. **Go targets cannot be traced with `LD_PRELOAD`.** The Go runtime issues syscalls
   directly rather than through libc, so an interposer observes nothing. The same applies
   to statically linked binaries. This couples target selection (Phase 0) to interception
   mechanism (Phase 1), which `CLAUDE.md` does not note. Added as a sixth Phase 0 selection
   criterion with an empirical verification step. See `docs/EXECUTION-PLAN.md` §7.1.

2. **The syscall trace does not carry the information the oracle needs.** The shim records
   `pwrite(fd, offset, length)`; the oracle evaluates whether a specific key-value
   operation was acknowledged durable. Added a logical operation log emitted by the
   workload driver and correlated to the syscall stream by in-band markers on a dedicated
   file descriptor, rather than by timestamp. See `docs/EXECUTION-PLAN.md` §4.

### Status

Phase 0 not started. Scaffold only.

---

## 2026-08-15 — Phase 0: Prior art, positioning, target selection

### Tried

Read all five references (`docs/prior-art.md`). Evaluated the candidate pool against the six
criteria and selected redb as primary, SQLite as control (`docs/target-selection.md`). Built
`shim/src/probe.c` and ran the criterion 6 verification against both targets in the VM.

### Failed

**1. The positioning statement contained an unsourced number.** `docs/EXECUTION-PLAN.md` §1
claimed ALICE "does not scale past a few thousand operations". Pathfinder, the source that
claim was attributed to, makes only a qualitative statement — prior tools "still fail to
scale to larger applications" — with no threshold. No other source found supports the
number. The claim is withdrawn and the positioning statement rewritten in
`docs/prior-art.md`. This is the first thing that would have been attacked in a review, and
it was ours, not a reviewer's, to catch.

**2. The probe reported zero writes for redb while strace reported 74.** First run of the
criterion 6 verification:

```
strace: pwrite64 74, fdatasync 14, ftruncate 3, write 1
probe:  write 1, fdatasync 14, unlink 1        (no pwrite, no ftruncate)
```

Cause: glibc exposes `pwrite64` and `ftruncate64` as symbols distinct from `pwrite` and
`ftruncate`, and Rust's `std::fs` calls the 64-bit names. Interposing only the base names
observes none of a Rust target's writes. Fixed by interposing both variants into the same
counter, driven by a test that calls `pwrite64` and `ftruncate64` explicitly.

**3. The same bug again, for `mmap`.** After the fix, the probe reported no shared mappings
for SQLite, while strace showed `mmap(NULL, 32768, PROT_READ|PROT_WRITE, MAP_SHARED, 5, 0)`
— the WAL `-shm` file. SQLite is built with `_FILE_OFFSET_BITS=64`, so it reaches `mmap64`.
Fixed the same way.

**4. tdd-guard could not see any test run.** The guard ships reporters for vitest, jest,
pytest and others but not for `bun test`, and this project's tests must run inside the Linux
VM where the guard's host-side hook cannot observe them. Every implementation write was
blocked as "premature" because no failing test output existed from the guard's perspective.
Resolved with `core/tools/tdd-report.ts`, which runs `bun test` in the VM, converts bun's
JUnit output into the `TestRunOutput` shape tdd-guard's reporters emit, and writes it to
`.claude/tdd-guard/data/test.json`. Bun's JUnit `<failure>` elements carry no message, so the
run's console output is attached as the failure reason.

### Learned

**The 64-bit symbol split is the central risk of the `LD_PRELOAD` approach, not the Go
runtime.** The Go problem was known and recorded before any code was written
(`docs/EXECUTION-PLAN.md` §7.1); it announces itself loudly, because a Go target produces a
completely empty trace. The `pwrite`/`pwrite64` split is worse precisely because it is
quiet: the probe still reported `fdatasync` and `write`, so the output looked like a working
trace with a plausible shape. A shim that captures `fsync` but silently drops every data
write would produce crash states that are wrong rather than absent, and the Phase 2
enumeration would run happily on them. Phase 1's trace shim must interpose every
`*64` variant and must have a test that compares its call counts against `strace -c` for the
real target, not just for hand-written C.

**Verifying against two targets caught what one would not.** redb exposed the `pwrite64`
gap; SQLite exposed the `mmap64` gap. Neither target alone would have revealed both.

**SQLite's control role has a caveat already.** It maps its WAL `-shm` file `MAP_SHARED`,
which is an unobservable write path for us. redb has none. Recorded in `docs/coverage.md`.

### Model decision

None yet. The six questions in `docs/EXECUTION-PLAN.md` §6 remain open and are argued before
Phase 2, per `CLAUDE.md`.

### Gate status

Phase 0 exit criteria:

- [x] `docs/prior-art.md` covers all five references with the differentiation statement
- [x] Positioning statement written and defensible — rewritten after the unsourced claim was
      withdrawn
- [x] `docs/target-selection.md` names primary (redb), control (SQLite), and six rejections
- [x] Primary target's syscall path verified: `strace -f -c` and `LD_PRELOAD` probe agree
- [x] Maintainer activity in the last 90 days recorded

Verification output, run 2026-08-15 in the Lima VM (Ubuntu 24.04, aarch64, kernel 6.8.0):

```
redb-probe (8 transactions, alternating Durability::Immediate / None)
  strace -f -c : pwrite64 74  fdatasync 14  ftruncate 3  write 1
  probe.so     : pwrite   74  fdatasync 14  ftruncate 3  write 1  unlink 1
                 mmap(MAP_SHARED) 0

sqlite3 (WAL, synchronous=FULL, one table, one 4 KiB row)
  strace -f -c : pwrite64 32  fdatasync 11  ftruncate 2  unlinkat 3
  probe.so     : pwrite   25  fdatasync 10  ftruncate 2  unlink   3
                 mmap(MAP_SHARED) 1
```

The redb counts match exactly. The SQLite counts differ because the two runs are not the same
workload — the strace run inserted two rows and the probe run one — and because `strace`'s
`unlink` filter does not match the `unlinkat` syscall glibc's `unlink()` actually issues.
Both observe the same call *set*, which is what criterion 6 asks. Phase 1's transparency gate
requires count-for-count agreement on an identical run and is where that is established.

**Known probe limitation, not fixed:** the report is emitted from a destructor, so I/O issued
after it runs — notably stdio flushed at exit — is not counted. This is why the probe shows no
`write` for `sqlite3` while `strace` shows one. It does not affect the criterion 6 conclusion
and the probe is not used after Phase 0.

---

## 2026-08-15 — Phase 1: Trace capture

### Interception mechanism

`LD_PRELOAD` is the implemented mechanism. `strace` ingestion is not built.

| | `LD_PRELOAD` | `ptrace` / `strace` |
|---|---|---|
| Per-call cost measured here | ~40 µs including payload digest and store | 10–100 µs per call, before payload retrieval |
| Payload capture | buffer is in scope, digested directly | needs `process_vm_readv` per call |
| Observes raw `syscall()` | no | yes |
| Observes Go runtime I/O | no | yes |
| Target build changes | none | none |

The decision rests on the target rather than on the mechanism's merits: redb is
Rust, so it calls libc and is fully observable. The measured 10,000-operation
run took 0.4 s wall clock with tracing on, which leaves the Phase 4 campaign
compute budget to the crash-state work rather than to capture.

`ptrace` remains the fallback if a later target does not route through libc, and
that is the only reason a second mechanism would be built. eBPF was evaluated and
rejected against the userspace-only boundary in `CLAUDE.md`.

### Tried

Built the shim, trace format v1, the payload store, the reader and the replayer.
Ran redb's own test suite under interception.

### Failed

**1. The digest and the store both needed a design decision the plan had already
made differently.** `docs/EXECUTION-PLAN.md` §5 specifies blake3. The shim uses
SHA-256 instead: it is one self-contained file with no SIMD build configuration,
and at 10,000 operations the digest is not the bottleneck (0.4 s total for the
run, dominated by the payload writes). The property the store needs is collision
resistance, which both provide. The implementation is checked against reference
digests on both padding paths, since a hand-written hash that is subtly wrong
would silently merge distinct payloads into one object.

**2. `realpath` into a 512-byte buffer aborted the target.** glibc's `realpath`
writes up to `PATH_MAX` regardless of the destination size, so a short buffer is
a buffer overflow, and `_FORTIFY_SOURCE` terminated the workload. Path storage is
now `PATH_MAX` per descriptor with the descriptor table capped at 1024 entries.

**3. Replay wrote the right bytes to the wrong offsets.** The replayer opened
files with `a+`. On Linux `O_APPEND` ignores the position argument of a
positional write, so every write landed at the end of the file and a trace that
overwrote a header produced a file with the header appended instead. Opening
`r+`, falling back to `w+` for a file that does not exist yet, fixed it. The test
that caught it compares the replayed bytes against the bytes the traced workload
actually left on disk, which is the only comparison that would have caught it.

**4. `tdd-report` reported a previous run's results as the current ones.** bun
writes no JUnit file when a test module fails to load, and the bridge read the
stale file left from the run before. It now removes the file first and treats a
missing file as a failed run.

### Learned

**The marker channel needs to be excluded at open, not only at write.** The first
implementation filtered writes to the marker descriptor but still emitted an open
event for the marker file. The marker test passed anyway because it only counted
writes. A trace that contains an open for a file the target never opened is wrong
in exactly the way that is hard to notice later, when a persistence graph is
built from it.

**Interposing a call is not the same as interposing an operation.** `rename`,
`renameat` and `renameat2` are three symbols for one operation, and a target that
uses the third is invisible to a shim that hooks the first. The trace records
normalized call names for this reason, with the mapping written down in
`docs/trace-format.md` so the graph in Phase 2 does not have to rediscover it.

### Model decision

None. The six questions in `docs/EXECUTION-PLAN.md` §6 are still open and are
argued before Phase 2 implementation begins, per `CLAUDE.md`.

### Gate status

Phase 1 exit criteria:

- [x] A hand-written workload's trace matches a manually derived expected
      sequence exactly. `core/tests/integration/trace.test.ts` derives the
      sequence for the rename-based update protocol in a comment and compares
      the trace against it field by field.
- [x] The target's own test suite passes under interception. redb at commit
      `cff6e50`: 371 tests passed, 0 failed, both with and without
      `LD_PRELOAD`. The traced run produced 270 MB of trace and payloads.
- [x] Multithreaded capture preserves a total order without deadlocking. Four
      threads, 20 write-and-fsync pairs each; the submission and completion
      stamps together cover their range exactly once.
- [x] A 10,000-operation workload is traced in under 60 s, with size reported.
      0.4 s, 10,102 events, 2.5 MB of trace, 41 MB of payloads. The payload
      volume is that high because every 4 KiB page written in that workload is
      distinct, which is the case content addressing cannot compress.
- [x] Payload storage is content-addressed.

---

<!--
Entry template:

## YYYY-MM-DD — Phase N: <title>

### Tried
### Failed
### Learned
### Model decision (if any)
Question / reading A / reading B / conclusion / why the alternative was rejected
### Gate status
Which boxes are checked, which are not, and what is blocking
-->
