/**
 * The Phase 2 exit criterion: enumeration is deterministic and
 * seed-reproducible.
 *
 * `selectCrashPoints` fixes which crash points are enumerated for a seed;
 * `enumerateCrashStates` must then produce the same states, in the same order,
 * every time it is given that selection. Order matters as well as membership,
 * because a crash state is identified downstream by its position in the run.
 */

import { describe, expect, test } from 'bun:test'
import { selectCrashPoints } from '../../src/enumerate/crash-points'
import { enumerateCrashStates } from '../../src/enumerate/states'
import { ext4Ordered } from '../../src/graph/models'
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
    length: 1024,
    returnValue: 1024,
    errno: 0,
    digest: 'a'.repeat(64),
    ...fields,
  }
}

const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: Array.from({ length: 12 }, (_, i) =>
    i % 5 === 4
      ? event(i, { call: 'fsync', length: 0, returnValue: 0, digest: '' })
      : event(i, { call: 'write', path: `/db/${i % 3}` }),
  ),
  markers: [],
}

describe('enumeration determinism', () => {
  test('a seed fixes both the crash points and the states enumerated at them', () => {
    const run = () => {
      const crashPoints = selectCrashPoints(TRACE, { nonFsyncSampleRate: 0.3, seed: 42 })
      return enumerateCrashStates(TRACE, {
        model: ext4Ordered,
        bounds: { tornWrites: true, maxUnpersistedWindow: 4 },
        crashPoints,
      })
    }

    const first = run()
    const second = run()

    expect(JSON.stringify(second)).toEqual(JSON.stringify(first))

    // Only the selected crash points are enumerated.
    const enumerated = [...new Set(first.map((state) => state.crashPoint))]
    expect(enumerated).toEqual(selectCrashPoints(TRACE, { nonFsyncSampleRate: 0.3, seed: 42 }))
  })
})
