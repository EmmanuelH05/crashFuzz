# Prior art

All five references read on 2026-08-15. Papers 1, 2, and 3 were read in full from the
PDFs; paper 4 from the arXiv HTML rendering; paper 5 from the USENIX abstract, slides, and
the published TOS version's abstract rather than the full paper, which is enough for the
purpose it serves here (justifying an out-of-scope boundary).

| # | Reference | Read | Summarized | Differentiation stated |
|---|---|---|---|---|
| 1 | Pillai et al., *All File Systems Are Not Created Equal* (OSDI '14) — BOB, ALICE | [x] | [x] | [x] |
| 2 | Mohan et al., *Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing* (OSDI '18) — CrashMonkey, Ace, B3 | [x] | [x] | [x] |
| 3 | Bornholt et al., *Specifying and Checking File System Crash-Consistency Models* (ASPLOS '16) — Ferrite | [x] | [x] | [x] |
| 4 | Wang et al., *Scalable and Accurate Application-Level Crash-Consistency Testing via Representative Testing* (OOPSLA '25) — Pathfinder | [x] | [x] | [x] |
| 5 | Rebello et al., *Can Applications Recover from fsync Failures?* (ATC '20) | [x] | [x] | [x] |

Sources:

1. https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf
2. https://arxiv.org/pdf/1810.02904 — code: https://github.com/utsaslab/crashmonkey
3. https://jamesbornholt.com/papers/ferrite-asplos16.pdf — code: https://github.com/uwplse/ferrite
4. https://arxiv.org/abs/2503.01390 — code: https://github.com/efeslab/Pathfinder
5. https://www.usenix.org/conference/atc20/presentation/rebello

---

## 1. Pillai et al., *All File Systems Are Not Created Equal* (OSDI '14)

**What it does.** Two tools. BOB (Block Order Breaker) runs a workload, records the block
I/O it produces, reorders and truncates that block stream, and checks empirically which
*persistence properties* — atomicity and ordering guarantees the file system provides above
POSIX — actually hold. ALICE (Application-Level Intelligent Crash Explorer) takes a system
call trace of an application workload, converts it into *logical operations* (overwrite,
append, directory op), applies an *Abstract Persistence Model* (APM) that states which
atomicity and ordering constraints a given file system enforces, enumerates the crash
states that APM permits, and runs a user-written checker on each. Where a checker fails,
ALICE reports a *crash vulnerability* tied back to a source line.

**Findings this project uses.** Table 1 of the paper is the empirical persistence-property
matrix across six file systems in sixteen configurations. The properties directly relevant
to `docs/model.md`:

- Single-sector overwrites are atomic on every configuration tested.
- Single-block overwrite is non-atomic on most configurations; data-journaling modes are
  the exception.
- Multi-block appends and writes are non-atomic *everywhere*, including data journaling.
- Directory operations (`rename`, `link`, `unlink`) are atomic on every file system that
  uses journaling or copy-on-write; ext2 and btrfs are marked as exceptions for ordering
  between directory operations, not atomicity.
- Ordering: only ext3/ext4/reiserfs in `data=journal` mode and ext2 in sync mode persist
  all tested operations in order. Everything else reorders something.
- `append → rename` is a recognized special case: many file systems allocate blocks
  immediately when the append-then-rename idiom is detected, so the property holds in
  practice on ext4 `data=ordered` while not being guaranteed in general.

The paper's own conclusion is the operative one: "persistence properties vary widely among
file systems, and even among different configurations of the same file system … it is risky
to assume that any particular property will be supported by all file systems."

**Scale.** 11 applications (LevelDB 1.10 and 1.15, GDBM, LMDB, SQLite, PostgreSQL, HSQLDB,
Git, Mercurial, HDFS, ZooKeeper, VMWare Player), 34 configuration options, 60 static
vulnerabilities.

**What it does that we do not.**

- ALICE reports vulnerabilities *against a source line* using stack traces. We do not
  instrument or attribute to source; we report an externally visible durability violation
  with a reproducer. Source attribution is the maintainer's job, and `CLAUDE.md` explicitly
  forbids speculating about target internals.
- BOB tests file systems to *derive* persistence properties. We consume Pillai's derived
  properties as input to our model rather than re-deriving them. If our model disagrees
  with an observed file system, the model is presumed wrong, not the file system.
- ALICE explores append atomicity by splitting writes "into three parts regardless of
  size" in addition to block-sized micro-operations. Our torn-write model is narrower
  (prefix-or-nothing at a fixed granularity, journal decision 2) — a deliberate reduction
  in coverage in exchange for a state count we can defend as bounded.

**Why.** ALICE's value was establishing that application update protocols are broadly
unsafe across the file-system configuration space. That result is established. The
remaining question is whether it still holds for storage engines written after it was
published, which is an empirical question about targets, not about technique.

**Limitations the paper states.** ALICE is incomplete — it may miss vulnerabilities. It
requires hand-written workloads and checkers. For multithreaded workloads it "serializes
system calls in the order they were issued". It does not handle file attributes.

---

## 2. Mohan et al., *Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing* (OSDI '18)

**What it does.** B3 is an approach; CrashMonkey and Ace are its implementation. Ace
exhaustively generates workloads inside a bounded space (sequence length, file/directory
set, operation set, initial file-system state). CrashMonkey records the block I/O a
workload produces, replays it up to each persistence point to build a crash state, mounts
it, lets the file system recover, and compares persisted files and directories against an
oracle snapshot taken at that persistence point.

**The empirical claims our bound rests on**, quoted rather than paraphrased because the
whole bounding argument depends on them:

> "We observed that most reported bugs can be reproduced using small workloads of three or
> fewer file-system operations on a newly-created file system, and that all reported bugs
> result from crashes after `fsync()` related system calls."

> "24 out of the 26 reported bugs require three or fewer core file-system operations to
> reproduce on an empty file system."

> "All reported bugs involved a crash right after a persistence point: a call to
> `fsync()`, `fdatasync()`, or the global `sync` command."

The corpus behind those claims: 26 unique bugs (28 counting two that appear on two file
systems) across ext4, xfs, btrfs, and F2FS over five years, found by reading mailing lists
and the `xfstests` crash-consistency tests. Bugs by operation count: 3 need one op, 14 need
two, 9 need three. The four operations most often involved are `write`, `link`, `unlink`,
`rename`.

**Scale.** 3.37 million workloads per file system across seq-1, seq-2, seq-3-data,
seq-3-metadata and seq-3-nested categories, tested on 65 machines over 48 hours. Result: 24
of 26 known bugs reproduced, 10 new bugs found, plus one in the verified file system FSCQ.

**What it does that we do not.**

- **It tests file systems. We test applications on top of file systems.** This is the
  single largest difference and `CLAUDE.md` makes it a non-goal to cross it.
- **It does not reorder I/O.** Stated as a limitation in §4.4: "It does not simulate a
  crash in the middle of a file-system operation and it does not re-order IO requests to
  create different crash states. The implicit assumption is that the core crash-consistency
  mechanism, such as journaling or copy-on-write, is working correctly." We reorder, using
  Pillai's persistence properties as the legality rule, because for an *application* target
  the file system's reordering freedom is precisely the hazard under test. B3's assumption
  is sound for its purpose and wrong for ours.
- **It generates workloads exhaustively; we do not.** Ace synthesizes the workload space
  from an operation grammar. Our workloads are hand-written shapes driving a real database
  through its own API, because the property under test is the target's update protocol, not
  the file system's operation matrix.

**Why.** We take B3's bound and reject B3's crash model. The bound is an empirical finding
about where bugs live and transfers to any layer. The no-reordering decision is specific to
testing a file system whose journaling is assumed correct.

**Limitations the paper states.** Sound but incomplete. Bounds do not expose bugs needing
many operations or resource exhaustion. Does not explore workloads without explicit
persistence. Black-box, so it cannot attribute a bug to a line of code.

---

## 3. Bornholt et al., *Specifying and Checking File System Crash-Consistency Models* (ASPLOS '16)

**What it does.** Proposes *crash-consistency models*, explicitly analogous to memory
consistency models, as the way to specify what a file system guarantees across a crash. A
model comprises litmus tests (small programs with allowed and forbidden post-crash
outcomes) plus axiomatic and operational specifications. Ferrite validates a model against
a real implementation two ways: an enumerator built on QEMU that executes litmus tests
against the actual file system, and a symbolic model checker built in Rosette that executes
them against the formal specification. The paper develops a crash-consistency model for
ext4 and demonstrates unintuitive real ext4 behavior. It also prototypes a verifier and a
synthesizer for crash-safe application code.

**Vocabulary we adopt.** "Crash-consistency model" for the specification of legal post-crash
behavior; "litmus test" for a minimal workload with an enumerated set of allowed outcomes;
the framing of file-system reordering as a *relaxation* that is invisible until a crash
makes it visible, which is exactly the memory-model analogy. `docs/model.md` is a
crash-consistency model in this sense — informal, empirical, and specific to our targets,
but the same object.

**What it does that we do not.** Formal specification, symbolic model checking, verification
and synthesis. `CLAUDE.md` makes formal verification and model checking non-goals. Ferrite
proves properties about a specification; we run a real target on a real image and observe
what happens. Where Ferrite's failure mode is a specification that does not match the
implementation, ours is a model that permits states the file system would never produce
(false positive) or forbids ones it would (missed bug).

**Why.** Formal work needs a specification to check against, and no specification exists for
the durability contract of an arbitrary embedded key-value store — the contract is a
sentence in a doc comment. Empirical testing is what applies to that situation. We borrow
the vocabulary because using recognized terms makes a report legible to a maintainer.

---

## 4. Wang et al., *Pathfinder* (OOPSLA '25)

**What it does.** Traces a program's storage operations, converts the trace into a
*persistence graph* — a directed acyclic graph whose nodes are operations that update
durable storage (write syscalls for POSIX targets, memory stores for MMIO targets) carrying
both static information (source location) and dynamic information (call stack, argument
values), and whose edges are happens-before dependencies enforced by the program, CPU, or
file system. It then applies *representative testing*: crash states are grouped by *update
behavior* — semantically related operation sequences, identified by call stack for POSIX
targets — on the observation that "the consistency of crash states is often correlated, even
if those crash states are not identical". One representative per group is model-checked
instead of the whole group.

**Scale and result.** 18 bugs (7 new) across 8 production systems: LevelDB, RocksDB and
WiredTiger on the POSIX side; Memcached, Redis, HSE, LevelDB-MMIO and RocksDB-MMIO on the
MMIO side, plus 102 bugs (49 new) in microbenchmarks. Against ALICE under a two-hour limit
it finds 4x more bugs in POSIX applications.

**On ALICE's scalability.** The paper's claim is qualitative, not a numeric threshold. It
says prior tools "eliminate redundancy in the search space by skipping identical crash
states, but they still fail to scale to larger applications", and that techniques that do
scale "sacrifice coverage and may miss bugs lodged deep within applications". The scope
statement in `CLAUDE.md` and `docs/EXECUTION-PLAN.md` §1 says ALICE "does not scale past a
few thousand operations" — **that specific number is not supported by this paper and must be
dropped or sourced elsewhere.** See the positioning statement below, which is corrected
accordingly.

**What it does that we do not.**

- MMIO and persistent-memory targets. `CLAUDE.md` makes those a non-goal.
- Grouping by call stack, which requires symbolizing the target's stack at each operation.
  We correlate by in-band markers emitted by the workload driver
  (`docs/EXECUTION-PLAN.md` §4), which gives us logical-operation identity without touching
  the target's build or symbols.
- Model checking over subsets of the persistence graph. We enumerate under explicit
  numeric bounds instead, which is weaker coverage and easier to state honestly.

**Why this is the most dangerous reference for us.** It is recent, it does what we do, it
does it better, and it shares our vocabulary — we take the term "persistence graph" from it.
Our remaining distinct claim is the target set and the bound, not the technique. Two of
Pathfinder's three POSIX targets (LevelDB, RocksDB) are also in ALICE's or its successors'
sets; none of the three is our primary. That is the whole of our contribution and the
write-up must say so plainly.

**Limitations the paper states.** Representative selection can produce false negatives.
Limited multithreading support. Results depend on the traces provided, so path coverage is
not guaranteed. Grouping heuristics differ by application class.

---

## 5. Rebello et al., *Can Applications Recover from fsync Failures?* (ATC '20)

**What it does.** Studies what happens when `fsync` *fails* rather than when a crash
happens. Characterizes ext4, xfs and btrfs behavior on `fsync` failure — pages are always
marked clean regardless, so a retry cannot recover the lost data; failure reporting and
surviving page content differ across file systems. Then examines how five applications
(PostgreSQL 12.0, LMDB 0.9.24, LevelDB 1.22, SQLite 3.30.1, Redis 5.0.7) handle it. The
conclusion: the strategies applications use are varied and none is sufficient; `fsync`
failure can cause data loss and corruption.

**What it does that we do not.** Everything. This is a different fault: the syscall returns
an error and the application mishandles it, with no crash involved. Our fault model is a
power loss at a point where every syscall succeeded.

**Why it is out of scope.** Three reasons, and they are the justification `CLAUDE.md` asks
for. First, the injection mechanism is different — it needs a failing block device or an
error-injecting file system layer, not crash-state materialization. Second, the oracle is
different: the question is whether the application *reported* the failure correctly and
what it did to its in-memory state, not what survived on disk. Third, the fault is not in
our persistence model at all; `docs/model.md` assumes every intercepted call returned
success, and every trace with a non-zero `errno` on a persistence call is out of the
model's domain. Traces containing a failed `fsync` are therefore rejected at ingest rather
than analyzed, and this is recorded in `docs/coverage.md`.

---

## Positioning statement

> CrashMonkey tests file systems and does not reorder I/O. ALICE tests applications and
> reorders I/O, but its target set is from 2014 and it needs a hand-written checker per
> workload. Pathfinder tests applications and scales further than both, on LevelDB, RocksDB
> and WiredTiger. crashfuzz applies ALICE's reordering model, under B3's empirical bound,
> to a storage engine none of them tested — redb — with the oracle derived mechanically from
> the engine's own written durability guarantee rather than hand-written per workload.

### Defending it against "why hasn't this already been done"

**It largely has been.** The technique is fifteen years old in its essentials and eleven
years old in the form we use. The honest claim is narrow and has three parts:

1. **The target has not been tested this way.** ALICE's set predates redb by eight years.
   Pathfinder's POSIX set is LevelDB, RocksDB, WiredTiger. redb's own test suite includes
   crash-injection tests written by its author, which is a real prior investment and lowers
   our expected yield — recorded in `docs/target-selection.md` as a known risk, not hidden.
2. **The oracle comes from the target's stated guarantee.** ALICE requires a checker per
   workload. redb states one sentence — `Durability::Immediate` commits "are guaranteed to
   be persistent as soon as `WriteTransaction::commit` returns" — which is directly
   mechanizable into a check that applies to every workload without further authoring.
3. **The bound is stated as a number with a citation, not as a time limit.** Pathfinder
   compares under a two-hour budget; B3 bounds by sequence length. We bound by sequence
   length and unpersisted-window size, each value carrying its justification in the config
   file, so coverage is a claim we can state precisely rather than a function of how long
   the machine ran.

**What survives if all three are attacked.** If a maintainer says "this is ALICE, applied to
my database", the correct answer is yes, and the value is the result rather than the method.
If the result is that redb is clean across the bounded space, that is a partial result and
`docs/findings.md` reports it as one — which `CLAUDE.md` requires.

**Correction to the plan's positioning.** `docs/EXECUTION-PLAN.md` §1 claims ALICE "does not
scale past a few thousand operations". Pathfinder does not support that number and no source
found does. The claim is withdrawn; the version above replaces it and must be propagated to
`docs/EXECUTION-PLAN.md` §1 and the README.

---

## What each reference supplied

- **Pillai:** the persistence-property matrix. Feeds `docs/model.md` and the Phase 2 edge
  types directly. Also the finding that multi-block appends are non-atomic on every
  configuration, which sets torn-write modeling as mandatory rather than optional.
- **Mohan:** the quoted empirical claims above. The three-operation bound and the
  fsync-adjacent crash-point rule are theirs; §4.4's no-reordering limitation is the
  boundary we deliberately cross.
- **Ferrite:** the terms "crash-consistency model" and "litmus test", and the memory-model
  analogy that makes reordering legible to a reader who has not read the storage
  literature.
- **Pathfinder:** the term "persistence graph" and its node/edge definition, which we adopt
  as-is. Also the most current statement of what the state of the art finds, which is what
  our results are measured against.
- **Rebello:** the out-of-scope justification for `fsync` error handling, and the concrete
  rule that traces containing a failed persistence call leave our model's domain.
