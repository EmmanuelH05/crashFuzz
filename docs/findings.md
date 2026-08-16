# Findings

Per `CLAUDE.md`: bugs found, or — if none — what was verified clean and what that
verification establishes. A tool that runs correctly and finds nothing is a partial result
and is reported as one.

## Bugs

**One real bug, independently rediscovered.** Tested directly against 3.1.3 (what the
campaign ran) and 4.1.0 (the newest tagged release), redb permanently loses an intact
database to a crash-legal image: `Database::open` panics on an assert instead of running
the recovery that — as the fixed master proves — would have restored every acknowledged
operation. `git tag --contains` against all 75 tags confirms no released version contains the fix,
though only 3.1.3 and 4.1.0 were tested directly; older releases (0.x–2.x) use a different
page store and were not checked. The maintainer found and fixed the same bug on
master on 2026-06-13 — before target selection, not after, and unknown to us until after
triage; see the Phase 5 journal entry. Because the bug is already acknowledged and fixed
upstream, there is no report to file that adds anything — see `docs/disclosure.md` for the
report that would have been filed and for what remains actionable. Nothing has been sent to
anyone.

The other confirmed bug this tool has found is in `targets/unsafe-kv`, an application
written for this repository specifically to contain it. That is the positive control, not a
finding.

### Real: redb panics on open — losing an intact database — on an image whose file is shorter than its header's layout

The full sweep — 10,942 states across 20 filesystem and shape combinations — produced one
signature that is not obviously ours. It fires on the 256 KiB-value shape on ext4
`data=ordered`, xfs and btrfs, on no other shape, and on no other filesystem. Eleven states
out of 704 make redb's query tool abort on open:

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
write. In the packaged state, every earlier `ftruncate` persisted — each was pinned by an
`fdatasync` — and only the last one did not:

| `ftruncate` | New length | Persisted |
|---|---|---|
| stamp 3 | 1,056,768 | yes |
| stamp 42 | 2,109,440 | yes |
| stamp 60 | 4,214,784 | yes |
| stamp 126 | 8,425,472 | yes |
| stamp 272 | 16,846,848 | **no** |

The resulting image is 8,650,240 bytes carrying a header that describes the 16 MiB layout.
The finding reproduces from the packaged image alone: mount it, run `redb-query`, and redb
aborts.

The same trace produces the finding on ext4 `data=ordered`, on xfs, and on btrfs, and
produces nothing on ext4 `data=journal`, whose model persists operations in program order and
therefore
cannot drop the `ftruncate` while keeping a later write. That the finding appears exactly
where the model permits the reordering, and nowhere else, is evidence that it comes from the
modelled reordering rather than from a harness accident — but it is not evidence that the
reordering is one ext4 actually performs.

**What settled it.** Three pieces of evidence, gathered 2026-08-16 and detailed in the
Phase 5 journal entry:

1. **The reordering is real.** The experiment the previous version of this document called
   for was run: on a dedicated ext4 `data=ordered` filesystem (kernel 6.8.0), with the
   journal commit interval stretched to 300 s so background writeback and the journal could
   be told apart, the same sequence — durable base, `ftruncate` grow, 320-byte overwrite at
   offset 0, no persistence call — left the block device holding the new bytes at the old
   length. Under `data=journal` the same run reorders nothing, which is also exactly how the
   finding distributed across the campaign. Reproduce with
   `core/tools/ftruncate-vs-overwrite.ts`.
2. **The maintainer had already reached the same conclusion.** redb commit `fd82ced`
   ([PR #1276](https://github.com/cberner/redb/pull/1276), merged 2026-06-13): "the only
   barrier ordering that extension against the subsequent header write was the commit's
   final fsync ... if a crash persisted that header but not the file extension, every
   subsequent open failed ... **permanent data loss** — even though the previous durable
   state was intact. In v4.1.0 and earlier the equivalent open-path assert panicked
   instead." That is this finding, described by its author, before we found it.
3. **The lost data was recoverable, which is what makes the panic a loss.** Against a build
   of redb master (`cff6e50`, carrying the fix and its two follow-ups `c002202` and
   `88881b8`), the same image — length-corrected to the strictly legal 8,425,472, see below
   — opens, passes redb's own integrity check, and returns k1 through k15 with all fifteen
   digests equal to the acknowledged ones in the marker channel. Released versions panic on
   an image from which everything they promised was still recoverable.

The fix is in no release: the newest tag is v4.1.0 (2026-04-19), the fix landed 2026-06-13.
`redb = "4"` from crates.io today panics on this image.

**A correction the verification forced on us.** The packaged image is 8,650,240 bytes; the
strictly legal length is 8,425,472, the last persisted `ftruncate`. The difference is the
replayer letting kept writes past EOF extend the file, where real ext4 would journal — and
here lose — that size effect. The panic in released versions is indifferent to the
difference, but master rejects the 8,650,240 image (`File length does not correspond to a
valid region layout`) while recovering the 8,425,472 one. Had this not been caught, this
document would have wrongly reported the fixed version as still broken. It is the seventh
defect of this tool's own making, the first found by Phase 5 verification rather than by a
control, and it is recorded as a model divergence in `docs/model.md`. To reproduce master's
recovery, truncate the image's `main.redb` to 8,425,472 bytes first; released versions
panic at either length.

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
| `RECOVERY_FAILED` on redb, `large` shape, on ext4 `data=ordered`, xfs and btrfs | Phase 4 sweep | **Real bug** | redb aborts on an image whose file is shorter than its header's layout, losing a database that was fully recoverable. The reordering was demonstrated at the block layer on ext4 `data=ordered`; the xfs and btrfs occurrences rest on `docs/model.md`'s per-filesystem flags, not on a separate block-level test of those two. Acknowledged mechanism (upstream PR #1276), fixed on master, unreleased. See above. |
| Fixed master rejects the packaged image | Phase 5 verification | Our model wrong | The materialized length includes size effects of kept writes that ext4's journal, which lost the earlier `ftruncate`, could not have committed. The strictly legal length recovers cleanly on master. Released versions panic at either length, so the finding stands. |

Nine candidates: seven defects of our own — six model defects found by the controls and one
materialization imprecision found by Phase 5 verification — one deliberate bug in our own
positive control, and one real bug in released redb. The real one took 10,942 states across
four filesystems and five workload shapes to reach. It appears in 3 of the 20 combinations
and in 11 of the 704 states of each.

## Verified clean

See `docs/results.md` for the current table, which is regenerated by `bun run campaign`
rather than edited.

- **redb** over 10,942 crash states across 4 filesystem configurations (ext4 `data=ordered`,
  ext4 `data=journal`, xfs, btrfs) and 5 workload shapes (single-writer, large values, many
  small values, mixed durability, four concurrent writers), under the persistence model in
  `docs/model.md`. 17 of the 20 combinations reported nothing; the other 3 reported the one
  real signature above.
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
4. **Six oracle defects were found by the controls, and the seventh by the hostile
   verification of the one real finding.** The rate at which this tool produced false
   positives against well-behaved targets is the strongest available evidence about how much
   a clean run is worth. It went to zero, but only because the controls and the verification
   step kept forcing it there.

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
5. **Trusting the materialized image as the legal state.** The replayer lets a kept write
   extend the file, so the packaged image carried a length ext4's journal could not have
   produced, and the fixed redb rejected it where it recovers the strictly legal variant.
   The finding survived because released versions panic at either length, but only the
   Phase 5 re-verification against master exposed the difference.
