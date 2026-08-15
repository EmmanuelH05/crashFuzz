/**
 * Crash point selection.
 *
 * A trace of n operations has n crash points. Enumerating states at every one
 * of them is the cost that bounds exist to control. Mohan et al. (OSDI '18)
 * report that every bug they reproduced involved a crash right after a
 * persistence point, so those crash points are always selected and the rest are
 * sampled. See core/src/enumerate/bounds.jsonc for the rate and its
 * justification.
 */

import type { Trace } from '../trace/reader'

const PERSISTENCE: ReadonlySet<string> = new Set(['fsync', 'fdatasync', 'sync_file_range'])

export type SelectionOptions = {
  /** Fraction of crash points not adjacent to a persistence call to sample. */
  nonFsyncSampleRate: number
  /** Fixes the sample. The same seed and trace select the same crash points. */
  seed: number
  /**
   * Workloads no longer than this are enumerated exhaustively rather than
   * sampled. See bounds.jsonc. Omitted means always sample.
   */
  maxExhaustiveWorkloadOps?: number
}

/**
 * Selects the crash points to enumerate, in ascending order. Sampling is a pure
 * function of the seed and the crash point index rather than a running
 * generator, so the selection does not depend on iteration order or on which
 * other points were considered.
 */
export function selectCrashPoints(trace: Trace, options: SelectionOptions): number[] {
  const selected: number[] = []

  const exhaustive = options.maxExhaustiveWorkloadOps ?? 0
  if (trace.events.length <= exhaustive) {
    return trace.events.map((_, index) => index)
  }

  for (let index = 0; index < trace.events.length; index++) {
    const isPersistence = PERSISTENCE.has(trace.events[index]!.call)
    const followsPersistence = index > 0 && PERSISTENCE.has(trace.events[index - 1]!.call)

    if (isPersistence || followsPersistence) {
      selected.push(index)
      continue
    }

    if (unitHash(options.seed, index) < options.nonFsyncSampleRate) {
      selected.push(index)
    }
  }

  return selected
}

/** splitmix32, mapped onto [0, 1). Deterministic for a given seed and index. */
function unitHash(seed: number, index: number): number {
  let x = (seed + index * 0x9e3779b9) | 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  x = x ^ (x >>> 15)
  return (x >>> 0) / 0x100000000
}
