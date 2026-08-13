# crashfuzz

An application-level crash-consistency checker. It records a target database's syscall
trace, enumerates the on-disk states a crash could legally leave behind, replays each one
through the target's own recovery path, and checks whether the durability the target
promised actually held.

> **Status: scaffold. Phase 0 not started.** No results or findings yet; this README is
> completed in Phase 6.
>
> Plan: [`docs/EXECUTION-PLAN.md`](docs/EXECUTION-PLAN.md) · Spec: [`CLAUDE.md`](CLAUDE.md)

## Requirements

Linux. `LD_PRELOAD`, ext4/xfs/btrfs, and loopback block devices are all required, so macOS
and Windows cannot host a run. On macOS, use the provided VM:

```bash
brew install lima
bun run vm:up      # Ubuntu 24.04 with ext4/xfs/btrfs and the toolchain
bun run vm:sh
bun run cf doctor  # verifies the environment can host a run
```

## Layout

| Path | Contents |
|---|---|
| `shim/` | `LD_PRELOAD` syscall interposer (C) |
| `core/` | Trace parsing, persistence graph, state enumeration, oracle, campaign runner (TypeScript) |
| `workloads/` | Workload drivers and workload shapes |
| `targets/` | Build recipes for the primary and control targets |
| `plots/` | matplotlib figure scripts and output |
| `docs/` | Prior art, target selection, correctness model, coverage, findings, journal |
| `vm/` | Lima VM definition |

## Phase status

| Phase | | |
|---|---|---|
| 0 | Prior art, positioning, target selection | Not started |
| 1 | Trace capture | Blocked on 0 |
| 2 | Crash state enumeration | Blocked on 1 |
| 3 | Recovery and the oracle | Blocked on 2 |
| 4 | Campaign | Blocked on 3 |
| 5 | Disclosure | Blocked on 4 |
| 6 | Write-up | Blocked on 5 |

## Safety

crashfuzz creates, mounts, and destroys filesystems. It operates only on loopback images
under `/var/lib/crashfuzz` inside the VM. Do not point it at a real filesystem.
