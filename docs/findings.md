# Findings

Per `CLAUDE.md`: bugs found, or — if none — what was verified clean and what that
verification establishes. A tool that runs correctly and finds nothing is a partial result
and is reported as one.

## Bugs

**None confirmed, one undecided.** Nothing has been filed with any maintainer, and on the
current evidence nothing should be.

The one confirmed bug this tool has found is in `targets/unsafe-kv`, an application written
for this repository specifically to contain it. That is the positive control, not a finding.

### Undecided: redb panics on an image whose file is shorter than its header's layout

The full sweep produced one candidate that is not obviously ours. On ext4 `data=ordered`
with 256 KiB values, 11 states out of 704 make redb's query tool abort on open:

```text
thread 'main' panicked at redb-3.1.3/src/tree_store/page_store/page_manager.rs:237:9:
assertion failed: storage.raw_file_len()? >= header.layout().len()
```

The image has the database header persisted while an earlier `ftruncate` that grew the file
did not persist, so the file is smaller than the layout its own header describes. redb's
protocol for growing the file, from the captured trace, is:

```text
ftruncate main.redb len=2109440    grow the file
pwrite    off=1576960 len=524288   data in the newly available region
pwrite    off=0       len=320      the header, which references the new layout
fdatasync                          the commit
```

The failing states drop an `ftruncate` issued after the last `fdatasync`, and keep a later
write.

**Why this is not filed.** The question that decides it is whether ext4 `data=ordered` can
leave a data write persisted while an earlier `ftruncate` on the same file is not, with no
intervening persistence call. Our model permits it: `docs/model.md` states that operations
persist in program order only under `data=journal`. But ext4 journals metadata in ordered
transactions, and an `ftruncate` is metadata, so an argument exists that the size change
cannot be missing once anything issued after it has committed. Nothing in the sources cited
in `docs/model.md` settles this either way, and `CLAUDE.md` is explicit that when it is
unclear whether a behavior is a violation, the default is that our model is wrong.

Two further reasons for caution. redb already has a regression test for a symptom of this
shape — `tests/crash_consistency.rs`, quoted in the Phase 0 journal entry, describes
`Corrupted("File truncated below stored layout")` — so a report that does not settle the
legality question adds nothing they do not have. And the assertion is reached through
`check_integrity`, which is documented as unnecessary during normal operation, so the
severity of an abort there is not obvious.

**What would settle it.** A test that writes the same sequence directly against a real ext4
`data=ordered` filesystem, crashes it at the block layer rather than by replaying a modelled
subset, and observes whether the header can reach the disk while the size change does not.
That is a filesystem-level experiment, and it is the thing to do next.

## Candidate violations, triaged

Every candidate the tool has ever produced, and what it turned out to be. The categories are
the ones `CLAUDE.md` requires: real bug, our model wrong, or undecided.

| Candidate | Where | Verdict | What it actually was |
|---|---|---|---|
| `LOST_ACKED` on SQLite, ~every state | Phase 3 control | Our model wrong | Operations older than `maxUnpersistedWindow` were dropped from every state instead of treated as persisted, so every acknowledgement depending on an early WAL write looked lost. `bounds.jsonc` described the intended behavior; the enumerator did not implement it. |
| Materialization crash on `ftruncate` | Phase 3 control | Our model wrong | A state can legally truncate a file whose data writes it dropped. `open(O_CREAT)` creates the inode independently of the bytes. |
| `RECOVERY_FAILED` on SQLite at early crash points | Phase 3 control | Our model wrong | The image predated the database file. A target cannot be blamed for refusing to open a file the crash point precedes. |
| Zero states tested on a workload with no `fsync` | Phase 3 positive control | Our model wrong | The fsync-adjacency bound sampled away a trace that had no persistence calls at all — precisely the bug class this project hunts. |
| `CORRUPT_INVARIANT` on redb, 20 states | Phase 4 sweep | Our model wrong | redb's `check_integrity` returns `Ok(false)` for "failed but was repaired". Repair after an unclean shutdown is redb's documented, correct behavior; reading it as corruption reported the feature as the bug. |
| `RECOVERY_FAILED` on redb at early crash points | Phase 4 sweep | Our model wrong | The crash point caught redb midway through creating its file, before anything had been acknowledged. A crash point that was promised nothing cannot have lost anything. |
| `LOST_ACKED` on `targets/unsafe-kv` | Phase 3 positive control | Real bug | The rename-based update protocol with no `fsync`, announcing durability anyway. The application is ours and was written to contain this bug. |
| `RECOVERY_FAILED` on redb, 11 states, `large` shape | Phase 4 sweep | **Undecided** | redb aborts on an image whose file is shorter than its header's layout. Whether the image is legal on ext4 `data=ordered` is unresolved. See above. |

Seven candidates: six model defects, one deliberate bug in our own control, one undecided.
The undecided one is the only candidate the tool has produced that is not obviously ours,
and it took roughly 4,000 states across four filesystems to reach it.

## Verified clean

See `docs/results.md` for the current table, which is regenerated by `bun run campaign`
rather than edited.

- **redb** across 4 filesystem configurations (ext4 `data=ordered`, ext4 `data=journal`,
  xfs, btrfs) and 5 workload shapes (single-writer, large values, many small values, mixed
  durability, four concurrent writers), under the persistence model in `docs/model.md`.
- **SQLite** in WAL mode at `synchronous=FULL` on ext4 `data=ordered`, as the control.

### What that verification is worth

Less than the state count suggests, and the honest limits are these:

1. **The bound is the result.** Crash points not adjacent to a persistence call are sampled
   at 5%, at most 24 states are materialized per crash point, and at most one write is torn
   per state. A bug living outside those bounds is not merely unfound, it is unreachable.
2. **Write-path coverage was never measured.** Nothing built redb with instrumentation, so
   there is no evidence about which parts of its write path the sweep touched. See
   `docs/coverage.md`.
3. **The workloads are short.** Long-running behavior — compaction, savepoints, reopening
   mid-workload, multi-process access — was never exercised.
4. **Six oracle defects were found by the controls, and the seventh would have been found by
   whoever received the report.** The rate at which this tool produced false positives
   against well-behaved targets is the strongest available evidence about how much a clean
   run is worth. It went to zero, but only after the controls forced it there.

A clean result here means "redb did not violate its documented durability contract in the
part of the crash state space this tool can reach". It does not mean redb is crash-safe.

## Failure log

Approaches that did not work, kept rather than removed.

1. **Treating "the enumerator produces the right state count" as evidence the enumerator was
   right.** The Phase 2 controls were unit tests over state sets, and they passed while the
   enumerator was dropping every operation older than its window. Nothing caught that until
   states were materialized as real filesystems and handed to a real database.
2. **Measuring the state explosion with a workload that called `fsync`.** The first
   unbounded curve reported an exponent of 2.44 and 1014 states at 18 operations, which
   would have been presented as evidence that the space is tame without the bounds. Every
   `fsync` pins earlier writes and shrinks the free set; with them removed the same 18
   operations produce 524286 states. A workload that calls `fsync` is not the worst case.
3. **Requiring a metadata operation to have an earlier persisted write on its path.** A
   plausible-sounding legality rule that silently deleted the 2009 ext4 data-loss state — the
   single most important state in the space — from the enumeration.
4. **Reading `check_integrity`'s return value without reading its contract.** `Ok(false)`
   means "repaired", not "corrupt". Twenty findings against a database that was recovering
   exactly as documented.
