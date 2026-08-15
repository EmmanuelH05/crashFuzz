#!/usr/bin/env bun
/**
 * Measures crash state count against trace length.
 *
 * The Phase 2 exit criterion is that the count is roughly polynomial in trace
 * length under the bounds in core/src/enumerate/bounds.jsonc. If it is not, the
 * bounds are wrong, so both curves are measured: the bounded one a run actually
 * enumerates, and the unbounded one it would face without the window cap and
 * the crash point sample.
 *
 *   bun run core/tools/state-explosion.ts
 *
 * Writes plots/data/state-explosion.csv. Render with `bun run plots`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadBounds } from '../src/enumerate/bounds'
import { selectCrashPoints } from '../src/enumerate/crash-points'
import { enumerateCrashStates } from '../src/enumerate/states'
import { ext4Ordered } from '../src/graph/models'
import type { Trace, TraceEvent } from '../src/trace/reader'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const OUT_PATH = join(REPO_ROOT, 'plots', 'data', 'state-explosion.csv')
const FIT_PATH = join(REPO_ROOT, 'plots', 'data', 'state-explosion-fit.json')

/** Trace lengths measured under the bounds. */
const BOUNDED_LENGTHS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]

/**
 * Trace lengths measured without the bounds. Stops at 18 because the unbounded
 * count is 2^n per crash point; 20 already costs more states than the rest of
 * the curve put together.
 */
const UNBOUNDED_LENGTHS = [1, 2, 3, 5, 8, 10, 12, 14, 16, 18]

const SEED = 20260815

export type Row = {
  operations: number
  regime: 'bounded' | 'unbounded'
  crashPoints: number
  states: number
}

/**
 * Least-squares slope of log(states) against log(operations), which is the
 * exponent p in states ~ operations^p. Reported so "roughly polynomial" is a
 * number rather than a look at the shape of a line.
 */
export function logLogSlope(rows: Row[]): number {
  const points = rows
    .filter((row) => row.operations > 1 && row.states > 0)
    .map((row) => ({ x: Math.log(row.operations), y: Math.log(row.states) }))

  const n = points.length
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n
  const covariance = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0)
  const variance = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0)

  return covariance / variance
}

/**
 * A synthetic workload shaped like a real update protocol: writes across a few
 * files, an fsync every fifth operation, a rename every twentieth.
 * Deterministic, so the curve is reproducible.
 */
export function syntheticTrace(operations: number, withPersistence = true): Trace {
  const events: TraceEvent[] = []

  for (let index = 0; index < operations; index++) {
    const file = `/db/file-${index % 3}`
    const base: TraceEvent = {
      index,
      completionIndex: index + operations,
      call: 'write',
      fd: 3 + (index % 3),
      threadId: 1,
      path: file,
      path2: '',
      offset: index * 1024,
      length: 1024,
      returnValue: 1024,
      errno: 0,
      digest: `${index}`.padStart(64, '0'),
    }

    if (index % 5 === 4 && withPersistence) {
      events.push({ ...base, call: 'fsync', length: 0, returnValue: 0, digest: '' })
    } else if (index % 20 === 19) {
      events.push({
        ...base,
        call: 'rename',
        path: `${file}.tmp`,
        path2: file,
        length: 0,
        returnValue: 0,
        digest: '',
      })
    } else {
      events.push(base)
    }
  }

  return { header: { version: 1, pid: 1 }, events, markers: [] }
}

function measureBounded(operations: number): Row {
  const bounds = loadBounds()
  const trace = syntheticTrace(operations)
  const crashPoints = selectCrashPoints(trace, {
    nonFsyncSampleRate: bounds.nonFsyncSampleRate,
    maxExhaustiveWorkloadOps: bounds.maxExhaustiveWorkloadOps,
    seed: SEED,
  })

  const states = enumerateCrashStates(trace, {
    model: ext4Ordered,
    bounds: {
      tornWrites: bounds.tornWrites,
      maxUnpersistedWindow: bounds.maxUnpersistedWindow,
    },
    crashPoints,
  })

  return { operations, regime: 'bounded', crashPoints: crashPoints.length, states: states.length }
}

/**
 * The same trace with the bounds off: every crash point, no window cap. This is
 * the curve the bounds exist to avoid, so it is measured rather than asserted.
 */
function measureUnbounded(operations: number): Row {
  // No fsync anywhere. An fsync pins earlier writes and shrinks the free set,
  // so a workload that calls one is not the worst case; this is.
  const trace = syntheticTrace(operations, false)
  const states = enumerateCrashStates(trace, {
    model: ext4Ordered,
    bounds: { tornWrites: false, maxUnpersistedWindow: operations },
  })

  return { operations, regime: 'unbounded', crashPoints: operations, states: states.length }
}

/**
 * The measurements as csv, and the fitted exponents beside them. The plotting
 * script draws the fit it is given rather than computing its own, so the number
 * on the figure comes from the estimator these tests cover.
 */
export function formatOutputs(rows: Row[]): { csv: string; fit: string } {
  const lines = ['operations,regime,crash_points,states']
  for (const row of rows) {
    lines.push(`${row.operations},${row.regime},${row.crashPoints},${row.states}`)
  }

  const bounded = rows.filter((row) => row.regime === 'bounded')
  const unbounded = rows.filter((row) => row.regime === 'unbounded')

  const fit = {
    boundedExponent: logLogSlope(bounded),
    unboundedExponent: unbounded.length > 0 ? logLogSlope(unbounded) : null,
    largestBounded: bounded.at(-1) ?? null,
  }

  return { csv: `${lines.join('\n')}\n`, fit: `${JSON.stringify(fit, null, 2)}\n` }
}

function main(): number {
  const rows = [...BOUNDED_LENGTHS.map(measureBounded), ...UNBOUNDED_LENGTHS.map(measureUnbounded)]
  const { csv, fit } = formatOutputs(rows)

  mkdirSync(join(REPO_ROOT, 'plots', 'data'), { recursive: true })
  writeFileSync(OUT_PATH, csv)
  writeFileSync(FIT_PATH, fit)

  const bounded = rows.filter((row) => row.regime === 'bounded')
  const unbounded = rows.filter((row) => row.regime === 'unbounded')
  const largest = bounded.at(-1)!

  console.log(`wrote ${OUT_PATH}`)
  console.log(`bounded   exponent p = ${logLogSlope(bounded).toFixed(2)} (states ~ ops^p)`)
  console.log(`unbounded exponent p = ${logLogSlope(unbounded).toFixed(2)} (not a power law)`)
  console.log(
    `bounded largest: ${largest.states} states over ${largest.crashPoints} crash points ` +
      `at ${largest.operations} operations`,
  )
  return 0
}

if (import.meta.main) {
  process.exit(main())
}
