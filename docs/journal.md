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
