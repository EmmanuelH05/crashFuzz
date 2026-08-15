/**
 * Crash point selection.
 *
 * Mohan et al. (OSDI '18) report that every bug they reproduced involved a
 * crash right after a persistence point. `bounds.jsonc` turns that into
 * "fsyncAdjacent+sample": every crash point next to a persistence call is
 * always selected, the rest are sampled at `nonFsyncSampleRate`.
 */

import { describe, expect, test } from 'bun:test'
import { selectCrashPoints } from '../../src/enumerate/crash-points'
import type { Trace, TraceEvent } from '../../src/trace/reader'

function event(index: number, fields: Partial<TraceEvent>): TraceEvent {
  return {
    index,
    completionIndex: index + 1000,
    call: 'write',
    fd: 3,
    threadId: 1,
    path: '/db/a',
    path2: '',
    offset: 0,
    length: 512,
    returnValue: 512,
    errno: 0,
    digest: 'a'.repeat(64),
    ...fields,
  }
}

/** Ten writes with an fsync at index 4. */
const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: Array.from({ length: 10 }, (_, i) =>
    i === 4
      ? event(i, { call: 'fsync', length: 0, returnValue: 0, digest: '' })
      : event(i, { call: 'write' }),
  ),
  markers: [],
}

describe('selectCrashPoints', () => {
  test('always selects the crash points adjacent to a persistence call', () => {
    // Rate 0 samples nothing, so only the fsync at index 4 and the operation
    // right after it survive.
    const selected = selectCrashPoints(TRACE, { nonFsyncSampleRate: 0, seed: 1 })

    expect(selected).toEqual([4, 5])
  })

  test('a seed reproduces its sample and different seeds differ', () => {
    // The Phase 2 exit criterion: enumeration is deterministic and
    // seed-reproducible. Rate 0.5 so the sample is large enough that two seeds
    // agreeing on all eight sampled points would be a 1-in-256 coincidence.
    const sample = (seed: number) => selectCrashPoints(TRACE, { nonFsyncSampleRate: 0.5, seed })

    expect(sample(7)).toEqual(sample(7))
    expect(sample(7)).not.toEqual(sample(8))
  })
})
