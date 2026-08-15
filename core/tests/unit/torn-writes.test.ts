/**
 * Torn writes, at the granularity `docs/model.md` fixes: 512-byte sectors,
 * prefix-or-nothing.
 *
 * Trace: one write of 2048 bytes, which is four sectors.
 *
 * Crash point 0, xfs, tornWrites on. The write is unconstrained by any
 * persistence call, so the legal states are the prefixes of the payload that
 * end on a sector boundary:
 *
 *   nothing            0 bytes
 *   first sector     512 bytes
 *   first two       1024 bytes
 *   first three     1536 bytes
 *   all four        2048 bytes   (the operation persisted in full)
 *                   ----------
 *                    5 states
 *
 * Not 2^4: model.md records that a large write persists as a prefix, not an
 * arbitrary subset of its sectors (Pillai §2.2.1).
 */

import { describe, expect, test } from 'bun:test'
import { enumerateCrashStates } from '../../src/enumerate/states'
import { xfs } from '../../src/graph/models'
import type { Trace, TraceEvent } from '../../src/trace/reader'

const WRITE: TraceEvent = {
  index: 0,
  completionIndex: 100,
  call: 'write',
  fd: 3,
  threadId: 1,
  path: '/db/a',
  path2: '',
  offset: 0,
  length: 2048,
  returnValue: 2048,
  errno: 0,
  digest: 'a'.repeat(64),
}

const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: [WRITE],
  markers: [],
}

describe('enumerateCrashStates with torn writes', () => {
  test('a four-sector write yields nothing, each prefix, and the whole write', () => {
    const states = enumerateCrashStates(TRACE, {
      model: xfs,
      bounds: { tornWrites: true, maxUnpersistedWindow: 8 },
    })

    const persistedBytes = states
      .map((state) => {
        if (state.persisted.includes(0)) return 2048
        return state.partial.find((p) => p.op === 0)?.bytes ?? 0
      })
      .sort((a, b) => a - b)

    expect(persistedBytes).toEqual([0, 512, 1024, 1536, 2048])
  })
})
