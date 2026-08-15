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

```text
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

```text
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

## 2026-08-15 — Model decisions for Phase 2

`CLAUDE.md` requires both readings of each persistence question argued in writing before
implementation, with the rejected argument recorded. The six questions are from
`docs/EXECUTION-PLAN.md` §6. Conclusions are transcribed into `docs/model.md`.

A note on citations. Pillai et al. Table 1 is the persistence-property matrix, but its
column headers are per-filesystem-configuration and do not survive text extraction
unambiguously. Where a claim below cites Pillai, it cites the paper's prose, which states
the same properties in words. Anything that would need the table's exact cell is marked as
unverified rather than asserted.

### 1. Is `rename` ordered after unfsynced writes to the renamed file?

**Reading A: model the ordering.** Pillai: "A special exception to this rule is when a file
is appended, and then renamed. Since this idiom is commonly used to atomically update
files, many file systems recognize it and allocate blocks immediately." On a
delayed-allocation filesystem such as ext4, the append-then-rename idiom is handled
specially and the data does reach disk before the rename. A model that reorders them
anyway would enumerate a state ext4 does not produce, and any violation found only in that
state is a false positive.

**Reading B: do not model it.** The ordering is not in POSIX and the paper's wording is
"many file systems", not all. xfs and btrfs are not covered by the ext4 delayed-allocation
special case. Assuming the ordering hides exactly the bug class that the 2009 ext4 data
loss incident made famous, which Bornholt et al. use as their opening example.

**Conclusion: per filesystem, defaulting to no ordering.** The edge exists in the ext4
model and not in the xfs or btrfs models. This is possible because each filesystem is a
separate module and each crash state is materialized on the filesystem it was enumerated
for, so a state is only ever checked against the filesystem that could produce it.

**Why B alone was rejected:** applying the weakest model everywhere would report, on ext4,
violations that ext4 cannot produce. `CLAUDE.md` treats a false positive as the
unrecoverable failure. Reading B survives as the default for filesystems where the
special case is not documented, which is where it is right.

### 2. Torn-write granularity

**Reading A: 512 bytes.** Pillai: "we observe that all tested file systems seemingly
provide atomic single-sector overwrites: in some cases (e.g., ext3-ordered), this property
arises because the underlying disk provides atomic sector writes." Below a sector there is
no atomicity to model; at exactly a sector there is. A 4 KiB write can therefore tear at
any of eight sector boundaries.

**Reading B: 4096 bytes.** Page-cache writeback moves whole pages, so tears in practice
land on page boundaries, and the host kernel here uses a 4 KiB page. Eight times fewer
states per write.

**Conclusion: 512 bytes, prefix-or-nothing.** A write of *n* sectors yields *n + 1* states
rather than 2^*n*, because Pillai reports that file systems generally persist a prefix of a
large append rather than an arbitrary subset of it: "most file systems seemingly guarantee
that some prefix of the data written (e.g., the first 10 blocks of a larger append) will be
appended atomically."

**Why B was rejected:** modeling at page granularity would fail to enumerate a state the
device can produce, which loses bugs silently. The prefix restriction is what keeps the
state count linear in the write size, so the finer granularity costs little.

**What this model still misses:** a device that tears within a sector, and a filesystem
that persists a non-prefix subset of a large write. Both are recorded in
`docs/coverage.md`.

### 3. Does `fsync(fd)` imply the directory entry is durable?

**Reading A: no.** This is the ALICE finding and the standard advice: a new file needs
`fsync` on the parent directory before its name is durable. Modeling it as required means
crashfuzz flags a target that omits the directory fsync.

**Reading B: yes, on some filesystems.** Mohan et al.: "file systems often offer guarantees
above and beyond what is required by POSIX. For example, on ext4, persisting a new file
will also persist its directory entry." Assuming Reading A on ext4 would produce a state
ext4 does not produce.

**Conclusion: per filesystem, same structure as decision 1.** The ext4 model treats a
returned `fsync` on a newly created file as also persisting its directory entry. The xfs
and btrfs models do not, absent an equivalent documented statement.

**Why a single answer was rejected:** the two readings are both correct, about different
filesystems. Choosing one globally trades a false positive on ext4 against a missed bug on
xfs and btrfs. Splitting by filesystem costs one flag per model module.

### 4. Default ext4 mode

**Reading A: `data=ordered`.** The distribution default, so it is what a user of the target
will actually run on, and it is the configuration a maintainer will assume when reading a
report.

**Reading B: `data=journal`.** A stronger and simpler model: Pillai reports that data
journaling modes persist all tested operations in order, so the enumeration under that mode
is a small subset of the ordered-mode enumeration. Fewer states, less room for the model to
be wrong.

**Conclusion: `data=ordered` as the default, `data=journal` swept alongside it in Phase 4.**

**Why B was rejected as the default:** a bug that only reproduces under `data=journal` is a
bug almost nobody can hit, and a clean result under `data=journal` says little about the
configuration people run. The simpler model is the wrong kind of simple here.

### 5. Is unacknowledged data that reached disk a violation?

**Reading A: yes, when it breaks a stated invariant.** A target may write speculatively,
but if a crash leaves a state its own recovery declares corrupt, that is a real failure
regardless of what was acknowledged.

**Reading B: no.** Data the target never acknowledged is unconstrained by definition. Every
storage engine writes ahead of its acknowledgements; treating that as a violation would
flag normal behavior everywhere.

**Conclusion: B, with one exception, which is Reading A's actual content.** Unacknowledged
data is never a violation on its own. It becomes one only when the target's own consistency
check fails on the recovered image, or when the recovered state is missing an operation the
target did acknowledge. Both are already covered by `CORRUPT_INVARIANT` and `LOST_ACKED`,
so `PHANTOM_UNACKED` fires only when the target's own checker fails, never on our judgment
of what should not be present.

**Why A as stated was rejected:** "breaks a stated invariant" invites us to decide what the
target's invariants are. That decision belongs to the target's own integrity check, which
redb exposes as `Database::check_integrity`.

### 6. Does `RECOVERY_FAILED` on a legal image count as a bug?

**Reading A: yes.** An image the model says is legal is one the filesystem could have left
after a power loss. If the target refuses to open it, every acknowledged durable write in
that database is unreachable, which is data loss with extra steps.

**Reading B: no.** Refusing to open is failing safe. A target that detects damage and stops
is behaving better than one that opens and returns wrong answers.

**Conclusion: A, and the target's own maintainer agrees.** redb's
`tests/crash_consistency.rs` is a regression test for exactly this shape, and its comment
describes the symptom as "every later open failed with `Corrupted("File truncated below
stored layout")` -- permanent data loss -- even though the previous durable state was
intact."

**Why B was not dismissed entirely:** it is right when the image is *not* legal. That makes
`RECOVERY_FAILED` the violation class most sensitive to the model being correct, so it is
triaged separately in Phase 4 and a `RECOVERY_FAILED` finding is not filed unless the
enumeration that produced the image can be justified line by line.

---

## 2026-08-15 — Phase 2: Torn writes, sampling, and real images

### Tried

Closed the four Phase 2 items that were written down but not implemented.

**Torn writes.** The enumerator now produces the sector-aligned prefixes decision 2 permits.
A write of *n* sectors contributes *n + 1* outcomes (nothing, each prefix, the whole write),
not 2^*n* subsets. Only `write`, `pwrite` and `writev` can tear; renames and unlinks are
atomic per the model table.

**Crash point selection.** `selectCrashPoints` implements the `fsyncAdjacent+sample` bound:
every crash point at or immediately after a persistence call is always selected, the rest
are sampled at `nonFsyncSampleRate`. Sampling is `splitmix32(seed, index)` — a pure function
of the seed and the crash point index rather than a running generator, so the selection does
not depend on iteration order or on which other points were considered. Two seeds over the
same trace disagree; one seed twice does not.

**Real images.** `createImage` makes a sparse file and a fresh filesystem in it;
`withMount` attaches a loop device, mounts, runs a callback and always detaches, including
when the callback throws. `materializeState` composes them with `replaySelection`, which
applies only the operations a state says persisted, cutting torn ones to their prefix. The
first end-to-end test makes a real ext4 filesystem, materializes a state with one full write
and one torn write, and reads both files back out of the mounted image.

**Measurement.** `core/tools/state-explosion.ts` measures the state count against trace
length, `plots/scripts/state_explosion.py` draws it, and both the data and the figure are
committed.

### Failed

**The first "unbounded" curve was not unbounded.** The synthetic workload calls `fsync`
every fifth operation, and an fsync pins every earlier write to the same file, so the free
set never grew. The curve labelled "no bounds" came out at 1014 states for 18 operations and
an exponent of 2.44, which would have been presented as evidence that the space is tame
without the bounds. It is not: with the fsyncs removed the same 18 operations produce 524286
states, exactly 2^19 - 2. The measurement now uses a workload with no persistence calls for
the unbounded curve, because a workload that calls fsync is not the worst case.

**Short workloads enumerated nothing.** Traces of one to three operations produced zero
crash points, because they contain no fsync and the 5% sample almost never fires that few
times. `maxExhaustiveWorkloadOps` was in `bounds.jsonc` with its justification and was not
read by any code. It is now applied: a workload within the bound gets every crash point.
This is the exact case Mohan et al. say most known bugs live in, so sampling it away was the
worst possible place for that gap.

**The bounded curve has a visible dip at five operations.** At three operations the
exhaustive bound gives all three crash points; at five it gives one sampled point. The dip
is the boundary between the two regimes, not noise, and it is left in the figure rather than
smoothed.

### Learned

The bounded count fits `states ~ ops^1.36` across the whole range and is closer to linear at
the top end — 500 to 2000 operations is 4x the length for 3.5x the states. 2000 operations
gives 103732 states over 857 crash points. That is polynomial, so the bounds hold. Without
them the same enumerator is 2^n and reaches half a million states by operation 18.

### Bound decision: how many operations may be torn in one state

**Reading A: any number.** Physically, every unpersisted write in the window could be
partially on disk at once. Modelling one at a time describes a machine that tears one write
and then stops.

**Reading B: one.** The space is the problem. Tearing every operation in the window
independently multiplies the per-crash-point count by (sectors + 1) per operation instead of
2, which for the configured window of 8 and a 4 KiB write is a factor of about 10^7.

**Conclusion: B**, recorded as `maxTornOpsPerState` in `bounds.jsonc`. It narrows the space,
so it loses states rather than inventing them, which is the direction the false-positive
asymmetry requires. A bug needing two simultaneously torn writes needs one torn write first,
so the cheaper state is likely to fire before the expensive one is needed.

**Why A was not dismissed entirely:** it is the honest physical model, and the bound is a
real gap in coverage rather than a free simplification. It belongs in `docs/coverage.md` as
something not tested, not as something ruled out.

### Gate status

All five Phase 2 boxes are now met: enumeration is deterministic and seed-reproducible and a
test asserts it; the three-operation hand computation matches; the state count is measured
and plotted; both controls pass. 39 tests across 12 files.

Not done, and not a Phase 2 gate: there is no `cf enumerate` subcommand, so the bounds reach
a real captured trace only through `core/tools/state-explosion.ts`, which builds its traces
synthetically. Phase 3 needs that wiring before it can point recovery at anything.

---

## 2026-08-15 — Phase 3: The oracle, and what the control caught

### Tried

The pipeline now runs end to end: trace, crash points, states, images, the
target's own recovery, oracle, deduplicated findings, reproducer artifact.

**The ack log.** `docs/model.md` says acknowledgement comes from the driver's logical
operation log, correlated by the marker channel. `parseAckLog` reads markers into one record
per logical operation, carrying `durable=1` or `durable=0`. An operation with no ack marker
is kept with `acknowledgedAt: null` rather than dropped, so the oracle can tell "never
promised" from "not in the log".

**The workload.** `targets/sqlite-workload` commits one row per operation at WAL and
`synchronous=FULL`, writing a marker either side. A test asserts that every ack marker is
stamped after an fsync that returned, which is what makes the marker a durability claim
rather than a timestamp. That test is the load-bearing one: if an ack could be stamped
before the fsync that earns it, every violation this tool reports would be suspect.

**The oracle.** `checkOracle` reports only what the contract plainly forbids.
`RECOVERY_FAILED` is one finding rather than one per key, because a database that will not
open loses all of them through a single root cause.

**Dedup.** `signatureOf` blames the earliest operation the acknowledgement depended on that
the state did not persist, with offsets excluded, so the same missing write at page 4 and
page 900 is one bug rather than two.

**The positive control.** `targets/unsafe-kv` is a deliberately broken application: write a
temporary file, rename it over the real name, announce durability, never fsync. The tool
finds the lost value on xfs and packages it as a reproducer.

### Failed

The control run reported violations on the first attempt. Per CLAUDE.md that means the
oracle is broken, and it was. Four defects, all ours, none SQLite's:

1. **Operations older than the unpersisted window were dropped from every state.**
   `bounds.jsonc` says they are "treated as persisted"; the enumerator neither persisted them
   nor put them in the mask, so they were in no state at all. Every acknowledgement that
   depended on an early WAL write looked lost in every image. This was the largest source.

2. **A file-existence rule deleted the positive control.** After fixing (1) the run failed
   materializing a state that truncated a file whose creating write it had dropped. The first
   fix required any metadata operation to have an earlier persisted write on its path, which
   promptly broke the rename-without-data control — the exact state the tool exists to find.
   `open(O_CREAT)` creates the inode, so a name can reach the disk while the bytes behind it
   do not. The rule now covers only the size-changing calls, and replay creates the empty
   inode for the rest.

3. **An image from before the database existed was reported as `RECOVERY_FAILED`.** Early
   crash points predate the file. The target cannot be blamed for refusing to open a file the
   crash point precedes, and nothing is acknowledged that early. Reported as an empty
   database instead, which leaves the oracle free to flag anything acknowledged and missing.

4. **A trace with no persistence call had almost every crash point sampled away.** Found by
   the positive control, which tested zero states on its first run. The B3 bound concentrates
   on crash points next to a persistence call because that is where Mohan et al. found every
   bug; a workload that never calls fsync has none, so the argument says nothing and the 5%
   sample skipped the trace. An application that promises durability without ever calling
   fsync is exactly the bug class this project hunts, so it was the worst possible thing to
   drop. Such traces now enumerate every crash point.

Three of the four would have produced false positives against a real target. The fourth
would have produced silence. The control caught all of them before any of them reached a
maintainer, which is the entire argument for having a control.

### Learned

A clean control run is worth nothing on its own. An oracle that never fires passes it
trivially, and would pass it just as happily if the pipeline were disconnected. The clean run
and the positive control only mean something as a pair, and the positive control is the one
that took the least effort and caught the subtlest gap.

The SQLite control tests 376 states over 23 crash points on ext4 `data=ordered` and reports
zero violations. The unsafe control reports the lost value on xfs.

### Gate status

Phase 3 exit criteria: the control reports zero violations; violations are deduplicated by
root-cause signature; `docs/model.md` has its known-legal weirdness section. Reproducers are
built and executed by a test, but no real violation has ever been packaged, because none has
been found — the artifact mechanism is proven, its application to a genuine finding is not.

Not done, and deliberately: the campaign does not sweep filesystems or workload shapes, and
`cf` still has no subcommands. Both are Phase 4.

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
