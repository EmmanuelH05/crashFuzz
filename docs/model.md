# Correctness model

> **Status: not written. Required before Phase 3.**
>
> `CLAUDE.md`: "Every bug claim is only as strong as this document." Each section below
> must be argued in `docs/journal.md` — two readings compared, rejected argument recorded —
> before it is implemented.

## Persistence model

Which reorderings are treated as legal, per filesystem and mount option. Each property
cites Pillai et al.

| Property | ext4 `data=ordered` | ext4 `data=journal` | xfs | btrfs | Citation |
|---|---|---|---|---|---|
| _(Phase 2)_ | | | | | |

Default mount option: to be determined. See journal decision 4.

## Atomicity assumptions

Whether torn writes are modeled, at what granularity, and the justification for that
granularity. See journal decision 2.

## The oracle

Operational definition of correct recovery:

> Every operation the target acknowledged as durable before the crash point is readable
> after recovery, and no operation the target never acknowledged has materialized in a way
> that violates the target's own invariants.

This is made checkable by the logical operation log described in
`docs/EXECUTION-PLAN.md` §4.

Violation classes: `LOST_ACKED`, `PHANTOM_UNACKED`, `CORRUPT_INVARIANT`, `RECOVERY_FAILED`.

## Target configuration

Durability guarantees depend on target settings. Any setting left unpinned here can
produce violations that are correct behavior.

| Target | Setting | Value | Rationale |
|---|---|---|---|
| SQLite (control) | `journal_mode` | `WAL` | The mode most deployments use, and the one whose durability depends on `synchronous`. Pinned so the control's expected behavior is a single known contract rather than a default that may vary by build. |
| SQLite (control) | `synchronous` | `FULL` | At `NORMAL` in WAL mode, SQLite documents that recently committed transactions may be lost after a power failure. |
| redb (primary) | `Durability` | `Immediate` for operations the oracle expects to survive; `None` for operations it must not expect | `Immediate` commits are documented as "guaranteed to be persistent as soon as `WriteTransaction::commit` returns" (`src/transactions.rs`). `None` carries no expectation and is used as an in-workload negative control. |

## Known-legal weirdness

Behaviors that resemble bugs but are permitted, recorded so they are not re-investigated.

1. **SQLite at `synchronous=NORMAL` in WAL mode may lose recently committed transactions
   after a crash.** Documented and intended, which is why the control's settings are
   pinned above.

The Phase 3 gate requires at least one entry; more are expected as the campaign runs.
