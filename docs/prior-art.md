# Prior art

> **Status: not written. Required before Phase 1.**
>
> `CLAUDE.md`: "Do not begin Phase 1 until these are read and summarized here."
> For each reference: what it does, what it does that this project does not, and why.

| # | Reference | Read | Summarized | Differentiation stated |
|---|---|---|---|---|
| 1 | Pillai et al., *All File Systems Are Not Created Equal* (OSDI '14) — BOB, ALICE | [ ] | [ ] | [ ] |
| 2 | Mohan et al., *Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing* (OSDI '18) — CrashMonkey, Ace, B3 | [ ] | [ ] | [ ] |
| 3 | Bornholt et al., *Ferrite* (ASPLOS '16) | [ ] | [ ] | [ ] |
| 4 | Pathfinder (2025) | [ ] | [ ] | [ ] |
| 5 | Rebello et al., fsync error handling | [ ] | [ ] | [ ] |

Sources:

1. https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf
2. https://arxiv.org/pdf/1810.02904 — code: https://github.com/utsaslab/crashmonkey
3. To locate
4. To locate
5. To locate

## Positioning statement

To be written. Draft in `docs/EXECUTION-PLAN.md` §1; not yet defended against the
"why hasn't this already been done" question required by the Phase 0 gate.

## What each reference needs to supply

- **Pillai:** the persistence-properties table — which properties hold on which
  filesystems under which mount options. Direct input to `docs/model.md`.
- **Mohan:** the exact empirical claim the bound relies on, quoted rather than paraphrased,
  since the entire bounding argument rests on it.
- **Ferrite:** terminology to adopt so the write-up uses recognized vocabulary.
- **Pathfinder:** a precise statement of why ALICE does not scale past a few thousand
  operations. That limit defines this project's scope boundary.
- **Rebello:** enough detail to justify fsync error handling being out of scope.
