# CLAUDE.md

## Project

`crashfuzz`: an application-level crash-consistency checker. It records a target
database's syscall trace, enumerates the on-disk states a crash could legally leave
behind, replays each one through the target's own recovery path, and checks whether the
durability the target promised actually held.

**The deliverable is a bug report acknowledged by someone who is not us.** Everything
below serves that. A tool that runs beautifully and finds nothing is a partial result and
must be reported as one, not dressed up as success.

## Required reading before writing code

Do not begin Phase 1 until these are read and summarized in `docs/prior-art.md`. The
summary must state, for each, what it does that we are not doing and why.

1. **Pillai et al., "All File Systems Are Not Created Equal" (OSDI '14).** The founding
   paper. Introduces BOB (reorders block-level traces to explore crash states) and ALICE
   (analyzes application update protocols for crash vulnerabilities). Found 60
   vulnerabilities across 11 applications. Source of the term *persistence properties*.
   `https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf`
2. **Mohan et al., "Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing"
   (OSDI '18).** CrashMonkey and Ace. Introduces B3: bound the infinite workload space,
   then exhaustively test inside the bound. Key empirical finding we exploit: most known
   bugs reproduce with three or fewer operations, and all of them involve crashes after
   fsync-related calls. `https://arxiv.org/pdf/1810.02904`, code at
   `https://github.com/utsaslab/crashmonkey`
3. **Bornholt et al., Ferrite (ASPLOS '16).** Formal framework for crash-consistency
   models and validating them against real implementations. Read for the vocabulary.
4. **Pathfinder (2025).** Persistence-graph representation, representative testing to
   scale past ALICE's limits. Read specifically for why ALICE fails to scale past a few
   thousand operations. That failure mode is our scope boundary.
5. **Rebello et al. on fsync error handling.** Reports that a small minority of
   applications handle fsync errors correctly. This is a second bug class, deliberately
   out of scope for v1 (see Non-goals) but worth knowing exists.

**Positioning we must be able to defend in one sentence:** CrashMonkey tests file systems.
ALICE tests applications but does not scale to large workloads. We test *applications*, on
*modern targets those papers predate*, with a *bound derived from their empirical findings*.

## Non-goals

Refuse these even if they look like natural extensions:

- Testing file systems themselves. CrashMonkey owns that. We test applications on top.
- fsync *error* handling (the EIO-on-fsync class). Different bug, different tool.
- Formal verification or model checking. We are an empirical tester.
- Kernel modules or filesystem patches. Userspace interception only.
- Performance work on the target. We are not optimizing anything.
- A GUI, hosted service, or CI integration for other people.
- Persistent-memory or MMIO targets.

If a phase starts drifting toward these, stop and say so.

## Target selection

Selection criteria, in priority order:

1. Makes an explicit, written durability guarantee we can turn into an oracle
2. Postdates or was not covered by ALICE's 2014 target set
3. Small enough to build, instrument, and reason about in a week
4. Active maintainers who respond to issues (check the last 90 days before committing)
5. Permissive license and a POSIX file API, no custom block layer

Candidate pool to evaluate in Phase 1, not to assume: embedded KV stores and newer
Rust/Go storage engines with real users but a fraction of SQLite's testing history. **Do
not target SQLite as the primary.** Use it as the control, because it is exhaustively
tested and should come back clean. If we report a bug in SQLite, the prior is
overwhelmingly that our tool is wrong.

Pick **one** primary and **one** control. Record the rejected candidates and why in
`docs/target-selection.md`.

## Correctness model

State these explicitly in `docs/model.md` before Phase 3. Every bug claim is only as
strong as this document.

- **Persistence model.** Which reorderings we treat as legal, per filesystem and mount
  option. Cite Pillai for each property. Note where ext4 `data=ordered` and `data=journal`
  differ, and pick one as the default.
- **Atomicity assumptions.** Whether we model torn writes, at what granularity, and why
  that granularity.
- **The oracle.** What "correct recovery" means operationally. Usually: every operation
  the target acknowledged as durable before the crash point is readable after recovery,
  and no operation the target never acknowledged has materialized in a way that violates
  its own invariants.
- **Known-legal weirdness.** Behaviors that look like bugs but are permitted. Every one we
  find goes here so we stop re-investigating it.

**The oracle is the project's weakest link.** A false positive from a wrong oracle burns
credibility with a maintainer permanently. When uncertain whether a behavior is a
violation, the default is "our model is wrong," not "we found a bug."

## Phases

Sequential. Do not start a phase with any prior checkbox unchecked. Each phase ends with a
commit and an entry in `docs/journal.md` recording what was tried, what failed, and what
was learned. The journal is not optional; it is the source material for the write-up and
for interview answers.

### Phase 0: Prior art and positioning

- [x] `docs/prior-art.md` covers all five readings with the "what we do differently" line
- [x] The one-sentence positioning statement is written and survives the question "why
      hasn't this already been done"
- [x] `docs/target-selection.md` names the primary, the control, and at least three
      rejected candidates with reasons

### Phase 1: Trace capture

Record the target's file I/O faithfully. No crash simulation yet.

- Intercept via `LD_PRELOAD` shim or `strace`/`ptrace`. Evaluate both; pick one and
  record the tradeoff.
- Capture: `write`, `pwrite`, `writev`, `fsync`, `fdatasync`, `rename`, `link`, `unlink`,
  `truncate`, `ftruncate`, `open` with `O_TRUNC`/`O_APPEND`, `mkdir`, `close`, `msync`
- Per event: fd, resolved path, offset, length, payload digest, ordering index, thread id,
  return value, wall time
- Trace format is versioned, append-only, and replayable without the target present

Completion conditions:
- [x] A hand-written workload's trace matches a manually derived expected sequence, exactly
- [x] The target's own test suite passes under interception (proves the shim is
      transparent)
- [x] Multithreaded capture preserves a total order without deadlocking
- [x] Trace of a 10k-operation workload captured in under 60s with size reported
- [x] Payload storage is content-addressed so repeated writes do not blow up trace size

### Phase 2: Crash state enumeration

Turn one trace into the set of legal post-crash disk images.

- Build the persistence graph: nodes are operations, edges are happens-before-for-
  persistence dependencies implied by the model in `docs/model.md`
- Enumerate reachable states at each crash point, honoring the graph
- Apply the B3 insight to bound the space: prioritize crash points immediately following
  fsync-family calls, and bound workload length. Every bound is a config value with a
  one-line justification in the config file itself.
- Materialize each state as a real image the target can be pointed at

Completion conditions:
- [ ] Enumeration is deterministic and seed-reproducible
- [x] A synthetic 3-operation trace produces exactly the hand-computed state count. Show
      the hand computation in the test file.
- [ ] State count vs. trace length is measured and plotted. If it is not roughly
      polynomial under the bounds, the bounds are wrong.
- [x] A deliberately reordered-unsafe toy workload is correctly flagged (positive control)
- [x] A correctly-fsynced toy workload is not flagged (negative control)

### Phase 3: Recovery and the oracle

- Point the target at each crash image, let it run its own recovery, then query
- Oracle checks the durability contract from `docs/model.md`
- Every violation is captured as a self-contained reproducer: the image, the trace prefix,
  the query, the expected result, the actual result

Completion conditions:
- [ ] Control target (SQLite) reports zero violations across the full bounded space. If it
      does not, the oracle is broken. Fix the oracle. Do not report the finding.
- [ ] Every violation reproduces on a clean machine from the artifact alone
- [ ] Violations are automatically deduplicated by root-cause signature, not by message
      string
- [x] `docs/model.md` has a "known-legal weirdness" section with at least one real entry

### Phase 4: The campaign

Run wide. Track everything.

- Sweep across filesystems and mount options: ext4 (both journal modes), xfs, btrfs
- Sweep workload shapes: single-writer, concurrent writers, large values, many small
  transactions, explicit `rename`-based update protocols
- Record coverage honestly: which parts of the target's write path were exercised and
  which were never touched

Completion conditions:
- [ ] At least 10,000 crash states tested on the primary target
- [ ] Results table by filesystem, mount option, and workload shape
- [ ] `docs/coverage.md` states what was *not* tested and why, in plain language
- [ ] Every candidate violation triaged into: real bug, our model wrong, or undecided.
      Undecided is an allowed and honest outcome.

### Phase 5: Disclosure

Only for violations that survive Phase 4 triage.

Before filing anything, do a hostile self-review: assume the maintainer's first reply is
"that is expected behavior, read the docs." Write their strongest rebuttal, then answer it.
If the answer is weak, do not file.

- [ ] Reproducer runs from a fresh clone with one command
- [ ] Report states: the guarantee (quoted from their docs), the workload, the crash point,
      the expected state, the observed state, and the environment
- [ ] The report does *not* speculate about their internals or propose a fix unless asked
- [ ] Filed, with the thread linked in the README regardless of outcome

### Phase 6: Write-up

- [ ] `README.md`: what it does, how to run it, results table, honest limitations
- [ ] `docs/findings.md`: bugs found or, if none, exactly what was verified clean and what
      that verification is worth
- [ ] Architecture diagram of trace to graph to state to oracle
- [ ] The failure log: at least three things that did not work, kept in
- [ ] A stranger can reproduce the headline result from the README alone

## Tooling and skills

- **Charting.** Latency and state-explosion plots go through generated matplotlib scripts
  committed alongside their output, so every figure regenerates from data.
- **Docs.** Everything is markdown in-repo. Do not generate Word or PDF unless explicitly
  asked; the audience is GitHub.
- **Diagrams.** Mermaid in markdown for the pipeline diagram, so it renders on GitHub and
  stays diffable.
- **Environment.** Everything runs in a VM or container with a scratch block device.
  Never point this tool at a real filesystem. Loopback images only.

## Working style

- **Reasoning council** on every decision that touches the correctness model: argue at
  least two readings of the persistence semantics against each other in writing, in
  `docs/journal.md`, before implementing. Record the losing argument.
- **The false-positive asymmetry governs everything.** A missed bug costs nothing. A
  wrongly filed bug costs the project's credibility and cannot be undone.
- Never claim a bug without a reproducer that runs on a machine you have not touched.
- Report partial progress honestly. "Phase 4 complete except coverage doc" is a valid
  status. "Phase 4 complete" when it is not is the one unrecoverable failure mode.
- Commit per phase with state counts and violation counts in the message.

## Interview readiness

The README plus journal must let you answer these cold:

1. Why a crash produces many legal disk states rather than one
2. What "legal" means here and where that definition comes from
3. How you bounded an infinite space, and which paper's empirical result justified it
4. What your oracle checks, and what it would miss
5. Why the control target came back clean and why that matters
6. What you found, or what you verified and what that verification is worth
7. The thing you got wrong first, and how you caught it

## Build invariants

Execution plan: `docs/EXECUTION-PLAN.md`. Decision rationale: `docs/journal.md`.

- **Runtime is Linux only.** `LD_PRELOAD`, ext4/xfs/btrfs, and loopback devices are all
  required and none exist on macOS. Use `bun run vm:up` then `bun run vm:sh`.
- **Crash images are written to `/var/lib/crashfuzz` on the guest disk**, never to the
  virtiofs mount, which does not provide the semantics under test.
- **Stack:** `shim/` is C, `core/` and `workloads/` are TypeScript on Bun, `plots/` is
  matplotlib. Use bun/bunx, not npm/npx.
- **Tests:** run every suite with `bun run test:vm [path]`, which executes `bun test` inside
  the VM and writes the result where tdd-guard reads it. Plain `bun test` on the host runs
  pure logic only and leaves tdd-guard blind, which blocks further edits.
- **Phase status is reported per checkbox.** Name any unchecked box rather than reporting
  the phase complete.
- **Changes to the persistence model require a written comparison of both readings in
  `docs/journal.md` before implementation.** See `docs/EXECUTION-PLAN.md` §5.

---

## Current state

Last updated 2026-08-15 at commit `294c936`. Phases 0 and 1 are complete; Phase 2 is partly
done. Anything below marked "not done" is the next work.

### Where things stand

| Phase | Status |
|---|---|
| 0 — Prior art, positioning, target selection | Complete |
| 1 — Trace capture | Complete, all five exit criteria met |
| 2 — Crash state enumeration | Partial: 3 of 5 exit criteria met |
| 3–6 | Not started |

Target: **redb** (Rust, Apache-2.0, `github.com/cberner/redb`). Control: **SQLite** (WAL,
`synchronous=FULL`). Rationale and the six rejected candidates are in
`docs/target-selection.md`.

Commits, newest first:

```text
294c936 phase2: filesystem models, crash state enumeration, controls
1571c38 docs: persistence model decisions argued and transcribed
13e4624 phase1: open flags, wall time, replay, format spec; all exit criteria met
30a54f1 phase1: thread ids, ordering stamps, markers, *at calls, trace reader
5fa6000 phase1: trace format v1, shim records writes, persistence and metadata calls
4e8c10c phase0: prior art, positioning, target=redb control=sqlite
389ca2b chore: scaffold repo, execution environment, and phase plan
```

### What exists

| Path | Contents |
|---|---|
| `shim/src/shim.c` | The trace shim. 14 normalized call names over about 20 libc symbols. |
| `shim/src/sha256.c` | SHA-256 for payload content addressing. Checked against external vectors. |
| `shim/src/probe.c` | Phase 0 only: counts calls to confirm a target routes I/O through libc. |
| `core/src/trace/reader.ts` | Parses trace v1 into typed events and markers, sorted by submission stamp. |
| `core/src/trace/replay.ts` | Applies a trace to a directory without the target present. |
| `core/src/graph/models.ts` | ext4-ordered, ext4-journal, xfs, btrfs. One flag per row of `docs/model.md`. |
| `core/src/enumerate/states.ts` | Crash state enumeration per crash point. |
| `core/src/enumerate/bounds.jsonc` | Bound values with the justification for each beside it. |
| `core/tools/tdd-report.ts` | Runs `bun test` in the VM and writes tdd-guard's `test.json`. |
| `targets/redb-probe/` | Small Rust workload used for the Phase 0 syscall-path check. |

Docs written: `prior-art.md`, `target-selection.md`, `model.md`, `trace-format.md`,
`coverage.md`, `journal.md` (four entries). `findings.md` is still a stub, correctly, since
nothing has been found.

28 tests across 6 files, all passing.

### Trace format v1, in one paragraph

Newline-delimited JSON in `<trace-dir>/trace-<pid>.jsonl`, payloads content-addressed in
`<trace-dir>/cas/<sha256-hex>`. Each event carries submission stamp `i`, completion stamp
`j`, normalized call name, fd, tid, resolved path, second path for rename and link, offset,
length, return value, errno, open flags, wall time, and payload digest. `i` and `j` come
from one counter in a `MAP_SHARED` page, so forked children continue the same sequence.
Writes to a file named `crashfuzz.marker` become `marker` records and are excluded from the
target's data path. Full spec: `docs/trace-format.md`.

### Phase 2: what is left

- [ ] Enumeration is deterministic and seed-reproducible. The enumerator is deterministic by
      construction (fixed iteration order, no randomness) but no test asserts it, and
      sampling is not implemented yet, which is where a seed will be needed.
- [ ] State count vs. trace length measured and plotted. `plots/` is still empty. The script
      and its output are both committed, per the tooling rules above.
- [ ] Torn-write states. `bounds.jsonc` specifies prefix-or-nothing at 512 bytes; the
      enumerator ignores the flag so far.
- [ ] The sampling bounds (`crashPoints`, `nonFsyncSampleRate`, `maxExhaustiveWorkloadOps`)
      are written down but not applied to real traces.
- [ ] Materializing a state as a real image: sparse file, make the filesystem, `losetup`,
      mount, apply the persisted subset, unmount, detach, snapshot. None of this exists yet
      and it is the bulk of the remaining Phase 2 work. `core/src/trace/replay.ts` is the
      application step it should call.

The two Phase 2 controls that pass are unit-level: they check that the enumerator produces,
or does not produce, the rename-without-data state. They do not yet run against a real
filesystem image.

### Environment

Lima VM named `crashfuzz`, Ubuntu 24.04 aarch64, kernel 6.8.0. `bun run vm:up` creates it,
`bun run vm:sh` opens a shell. The repo is mounted at the same path inside the VM
(`/Users/yungmanny/crashFuzz`), not under the guest home directory.

Installed in the VM by `vm/lima.yaml`: build tools, clang, ext4/xfs/btrfs userspace, strace,
sqlite3, python3 with matplotlib, bun, and a Rust toolchain. `/etc/profile.d/crashfuzz.sh`
puts `~/.bun/bin` and `~/.cargo/bin` on PATH.

Scratch state on the guest disk, not in the repo:

```text
/var/lib/crashfuzz/images        crash images (Phase 2, not yet used)
/var/lib/crashfuzz/cargo-target  CARGO_TARGET_DIR for redb builds
/var/lib/crashfuzz/suite/redb    redb clone used for the interception gate
```

### Things that will bite

1. **glibc exposes 64-bit variants as separate symbols:** `pwrite64`, `ftruncate64`,
   `truncate64`, `open64`, `mmap64`. Rust's `std::fs` and anything built with
   `_FILE_OFFSET_BITS=64` calls those names. Interposing only the base name produces a trace
   that looks plausible and is missing every data write. Any newly interposed call needs both
   spellings and a test that reaches the 64-bit one.

2. **`realpath` writes up to `PATH_MAX` regardless of the destination size.** A shorter
   buffer is a buffer overflow and `_FORTIFY_SOURCE` will abort the target.

3. **`O_APPEND` ignores the position argument of a positional write.** The replayer opens
   `r+`, falling back to `w+`. Opening `a+` sends every write to the end of the file.

4. **tdd-guard cannot see `bun test`.** It ships no bun reporter and the tests run inside the
   VM. `core/tools/tdd-report.ts` bridges both gaps. Use `bun run test:vm`; a run through
   plain `bun test` leaves the guard with stale or absent results and it blocks the next edit
   as "premature implementation".

5. **tdd-guard enforces one new test per cycle and minimal implementations.** Adding several
   tests at once, or writing a complete implementation before a red run, is rejected. Add one
   test, run `bun run test:vm`, confirm the red is for the right reason, then implement.

6. **The shim's marker handling applies at open as well as write.** A marker file traced as
   target I/O puts an operation in the graph that the target never performed.

### Decisions a new session should not relitigate

- The false-positive asymmetry decided the persistence model twice: properties differ per
  filesystem rather than being flattened into one conservative model, and any property no
  source states is disabled. See `docs/model.md` and the "Model decisions for Phase 2"
  journal entry.
- The positioning statement in `docs/EXECUTION-PLAN.md` §1 originally claimed ALICE "does not
  scale past a few thousand operations". No source supports that number; it was withdrawn and
  replaced. If it reappears, it is wrong.
- `docs/EXECUTION-PLAN.md` §5 specifies blake3 for payload digests. The shim uses SHA-256
  instead, for build simplicity, with the reasoning in the Phase 1 journal entry.
