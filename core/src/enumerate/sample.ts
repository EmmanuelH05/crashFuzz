/**
 * Sampling enumerated states down to what can be materialized.
 *
 * Enumerating a state costs microseconds. Materializing one costs a filesystem
 * creation, a loop device, two mounts and a target recovery, which is about
 * five orders of magnitude more. A crash point that enumerates thousands of
 * states cannot have all of them tested, so the campaign takes a seeded sample.
 *
 * This narrows coverage, so it loses bugs rather than inventing them, which is
 * the direction the false-positive asymmetry in CLAUDE.md requires. What it
 * drops is recorded in docs/coverage.md.
 */

import type { CrashState } from './states'

export type SampleOptions = {
  /** States materialized per crash point. See bounds.jsonc. */
  maxPerCrashPoint: number
  /** Fixes the sample, so a run is reproducible from its seed. */
  seed: number
}

/** splitmix32, mapped onto [0, 1). Deterministic for a given seed and index. */
function unitHash(seed: number, index: number): number {
  let x = (seed + index * 0x9e3779b9) | 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  x = x ^ (x >>> 15)
  return (x >>> 0) / 0x100000000
}

/**
 * Samples each crash point's states down to the cap, preserving enumeration
 * order. The first and last state of each group are always kept: they are the
 * boundaries of the space, where nothing unpinned persisted and where all of it
 * did, and leaving those to chance would waste the sample.
 */
export function sampleStates(states: CrashState[], options: SampleOptions): CrashState[] {
  const groups = new Map<number, CrashState[]>()
  for (const state of states) {
    const group = groups.get(state.crashPoint)
    if (group === undefined) groups.set(state.crashPoint, [state])
    else group.push(state)
  }

  const sampled: CrashState[] = []

  for (const [crashPoint, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length <= options.maxPerCrashPoint) {
      sampled.push(...group)
      continue
    }

    const keep = new Set<number>([0, group.length - 1])

    // Ranking by a hash of (seed, crash point, position) rather than shuffling
    // keeps the choice a pure function of the seed, so one crash point's sample
    // does not depend on how many states another crash point produced.
    const ranked = group
      .map((_, index) => ({ index, rank: unitHash(options.seed + crashPoint, index) }))
      .sort((a, b) => a.rank - b.rank)

    for (const candidate of ranked) {
      if (keep.size >= options.maxPerCrashPoint) break
      keep.add(candidate.index)
    }

    for (const index of [...keep].sort((a, b) => a - b)) {
      sampled.push(group[index]!)
    }
  }

  return sampled
}
