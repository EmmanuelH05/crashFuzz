# Disclosure

Phase 5 record for the one finding that survived triage:
`RECOVERY_FAILED|missing:ftruncate@main.redb`. Evidence in `docs/findings.md`, mechanism
and verification in the Phase 5 journal entry.

## Status: nothing filed, deliberately

The maintainer found, fixed, and documented this bug class on master before we found it —
commit `fd82ced`, [PR #1276](https://github.com/cberner/redb/pull/1276), merged 2026-06-13,
with open-path recovery follow-ups `c002202` and `88881b8`
([PR #1293](https://github.com/cberner/redb/pull/1293)). A bug report would be a duplicate
of something already diagnosed more precisely by its own author. Filing it would spend
credibility and add nothing.

What is still true and actionable: **no released version contains the fix.** The newest
release is v4.1.0 (2026-04-19); `redb = "4"` from crates.io today panics on open — losing
an intact, fully recoverable database — on a crash state this repository demonstrates a
stock ext4 `data=ordered` can produce. The one thing worth sending upstream is the release
inquiry drafted at the bottom of this document. **It has not been sent.** Sending anything
external is the operator's decision, not this tool's.

## Hostile self-review

Per `CLAUDE.md`: assume the maintainer's first reply is "that is expected behavior, read
the docs", write their strongest rebuttals, and answer them. If an answer is weak, do not
file.

**"This is already fixed on master."** Correct, and it is the reason no bug report exists
in this document. The residual claim is only about releases: 3.1.3 and 4.1.0 — the version
this project tested and the newest tag — both panic on this image, and `git tag --contains`
against all 75 tags confirms none contain the fix. The inquiry below asks one question —
whether a release containing the fix is planned — and claims nothing broader than that.

**"Your image is synthetic. A real ext4 would never leave that state."** Two answers. The
state's essential shape — header persisted, earlier file extension not, no intervening
persistence call — was demonstrated on a stock ext4 `data=ordered`, kernel 6.8, by
`core/tools/ftruncate-vs-overwrite.ts`: the block device held the new bytes at the old
length. And the maintainer's own PR #1276 describes the same state as reachable and worth
preventing. Our materialized image did differ from the strictly legal state in one respect
— its length carried implicit extensions ext4's journal would have lost — and we found,
recorded, and corrected that ourselves before concluding anything (Phase 5 journal entry).
3.1.3 and 4.1.0 both panic at either length.

**"The commit that grew the file never returned, so nothing was promised for it."**
Agreed, and no claim rests on the in-flight commit. The loss is of k1 through k15,
acknowledged durable by earlier `Durability::Immediate` commits whose `commit()` had
returned long before the crash point. redb's documented contract for those:
"guaranteed to be persistent as soon as `WriteTransaction::commit` returns"
(`src/transactions.rs`). The fixed master recovers all fifteen from the same image with
matching digests, which is what makes 3.1.3 and 4.1.0 aborting a loss rather than an
inconvenience.

**"A panic in an integrity check is not data loss."** The assert is not in
`check_integrity`; it is in the open path (`page_manager.rs:237` in 3.1.3, `:231` in
4.1.0). Every open of this database aborts, so the data is unreachable through redb by any
sequence of calls. An earlier draft of our own findings misattributed the assert to
`check_integrity`; the version matrix corrected it.

**"This window is too narrow to matter."** Possibly, and no claim about frequency is made.
The experiment stretched the journal commit interval to separate the mechanisms cleanly; it
demonstrates reachability, not rate. The maintainer's fix and its regression test are the
evidence that upstream considers the state worth handling regardless of rate.

## The report that would have been filed

Kept because Phase 5 requires it, and because writing it is how the review above happened.

> **redb 3.1.3 and 4.1.0 (newest release): Database::open panics, permanently losing a
> recoverable database, on a crash image whose file is shorter than its header's layout**
>
> **Guarantee.** "Commits with `Durability::Immediate` are guaranteed to be persistent as
> soon as `WriteTransaction::commit` returns" (`src/transactions.rs`); "redb will
> automatically detect and recover from crashes, power loss, and other unclean shutdowns"
> (README).
>
> **Workload.** Single writer issuing sequential puts of 256 KiB values, each committed
> with `Durability::Immediate`. At the crash point, 15 (k1 through k15) had been
> acknowledged after `commit()` returned. The 256 KiB values force the database file to
> grow repeatedly.
>
> **Crash point.** During a later commit's file growth: the `ftruncate` that grew the file
> was issued after the previous commit's `fdatasync` and had not persisted when the crash
> occurred; the subsequent 320-byte header write at offset 0 had. Both orders of events are
> possible on ext4 `data=ordered`, where the header overwrite persists by data writeback
> and the size change persists only with a journal commit; demonstrated on kernel 6.8.
>
> **Expected.** The database opens and recovers the 15 acknowledged operations.
>
> **Observed.** `Database::open` aborts on every attempt:
> `assertion failed: storage.raw_file_len()? >= header.layout().len()`
> (`page_manager.rs:237` in 3.1.3, `:231` in 4.1.0). All acknowledged data is unreachable.
>
> **Environment.** redb 3.1.3 and 4.1.0 from crates.io; Ubuntu 24.04, kernel
> 6.8.0-136-generic, aarch64; ext4 `data=ordered` on a loop device. Reproducer: crash
> image, trace prefix, and one-command run script; reproduced from the artifact alone on a
> freshly provisioned machine.

## Draft release inquiry — NOT SENT

For the operator to send or discard. It references upstream's own commits because it is
about releasing them, not about reporting anything new.

> Title: Release containing the file-growth durability fix (#1276)?
>
> While crash-testing redb 3.1.3 with a syscall-level crash-state enumerator, we
> independently reproduced the failure fixed by #1276: after a crash that persists the
> header but not the file growth, every `Database::open` panics on
> `raw_file_len >= layout().len()` (3.1.3 and 4.1.0; on current master the same image is
> recovered cleanly, and we confirmed all acknowledged keys come back with correct values).
> As far as we can tell no published release contains #1276 or the related open-path
> recovery work (#1293). Is a release planned? Happy to share the reproducing crash image
> and trace if useful.
