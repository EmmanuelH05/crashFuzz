/**
 * Phase 2 controls.
 *
 * Positive: the rename-based update protocol without any fsync. On a filesystem
 * that does not order the append before the rename, a state exists where the
 * new name is on disk and the data behind it is not. That is the 2009 ext4 data
 * loss shape and the enumerator must produce it.
 *
 * Negative: the same protocol with fsync of the file before the rename. Every
 * state that has the rename also has the data, so nothing is flagged.
 */

import { describe, expect, test } from 'bun:test'
import { enumerateCrashStates } from '../../src/enumerate/states'
import { xfs } from '../../src/graph/models'
import type { Trace, TraceEvent } from '../../src/trace/reader'

const BOUNDS = { tornWrites: false, maxUnpersistedWindow: 8 }

function event(index: number, fields: Partial<TraceEvent>): TraceEvent {
  return {
    index,
    completionIndex: index + 100,
    call: 'write',
    fd: 3,
    threadId: 1,
    path: '/db/f.tmp',
    path2: '',
    offset: 0,
    length: 512,
    returnValue: 512,
    errno: 0,
    digest: 'a'.repeat(64),
    ...fields,
  }
}

function trace(events: TraceEvent[]): Trace {
  return { header: { version: 1, pid: 1 }, events, markers: [] }
}

/** A state where the rename is on disk but the write behind it is not. */
function hasRenameWithoutData(states: ReturnType<typeof enumerateCrashStates>): boolean {
  return states.some((state) => state.persisted.includes(2) && !state.persisted.includes(0))
}

describe('crash state controls', () => {
  test('flags the rename-based update protocol with no fsync', () => {
    const unsafe = trace([
      event(0, { call: 'write', path: '/db/f.tmp' }),
      event(1, { call: 'close', path: '/db/f.tmp', length: 0, returnValue: 0 }),
      event(2, {
        call: 'rename',
        path: '/db/f.tmp',
        path2: '/db/f',
        length: 0,
        returnValue: 0,
      }),
    ])

    expect(hasRenameWithoutData(enumerateCrashStates(unsafe, { model: xfs, bounds: BOUNDS }))).toBe(
      true,
    )
  })

  test('does not flag the same protocol when the file is fsynced first', () => {
    const safe = trace([
      event(0, { call: 'write', path: '/db/f.tmp' }),
      event(1, { call: 'fsync', path: '/db/f.tmp', length: 0, returnValue: 0, digest: '' }),
      event(2, {
        call: 'rename',
        path: '/db/f.tmp',
        path2: '/db/f',
        length: 0,
        returnValue: 0,
      }),
    ])

    expect(hasRenameWithoutData(enumerateCrashStates(safe, { model: xfs, bounds: BOUNDS }))).toBe(
      false,
    )
  })
})
