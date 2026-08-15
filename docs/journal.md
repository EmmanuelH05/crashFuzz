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
