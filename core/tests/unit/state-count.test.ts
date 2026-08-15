/**
 * The state count for a three-operation trace, computed by hand and compared
 * against the enumerator. Required by the Phase 2 exit criteria in CLAUDE.md.
 *
 * Trace:
 *
 *   op 0  write(fileA, off 0, len 512)
 *   op 1  write(fileB, off 0, len 512)
 *   op 2  fsync(fileA)
 *
 * A crash point sits after each operation was issued. At a crash point, each
 * operation that has been issued is either persisted or not, subject to the
 * constraints in docs/model.md. Torn writes are off for this table, so an
 * operation is all or nothing.
 *
 *   crash after op 0   unconstrained: {op0}              2 states
 *   crash after op 1   unconstrained: {op0, op1}         4 states
 *   crash after op 2   op0 pinned by the fsync on fileA,
 *                      op1 unconstrained                 2 states
 *                                                       --------
 *                                                        8 states
 *
 * The fsync at op 2 is a durability floor for fileA: every write to fileA
 * issued before it must be present in every state enumerated at or after that
 * crash point. It says nothing about fileB, so op 1 stays free.
 */

import { describe, expect, test } from 'bun:test'
import { enumerateCrashStates } from '../../src/enumerate/states'
import { ext4Journal, ext4Ordered } from '../../src/graph/models'
import type { Trace, TraceEvent } from '../../src/trace/reader'

function event(index: number, fields: Partial<TraceEvent>): TraceEvent {
  return {
    index,
    completionIndex: index + 100,
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

const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: [
    event(0, { call: 'write', path: '/db/a' }),
    event(1, { call: 'write', path: '/db/b' }),
    event(2, { call: 'fsync', path: '/db/a', length: 0, returnValue: 0, digest: '' }),
  ],
  markers: [],
}

describe('enumerateCrashStates', () => {
  test('produces the hand-computed count for the three-operation trace', () => {
    const states = enumerateCrashStates(TRACE, {
      model: ext4Ordered,
      bounds: { tornWrites: false, maxUnpersistedWindow: 8 },
    })

    const byCrashPoint = new Map<number, number>()
    for (const state of states) {
      byCrashPoint.set(state.crashPoint, (byCrashPoint.get(state.crashPoint) ?? 0) + 1)
    }

    expect([...byCrashPoint.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 2],
      [1, 4],
      [2, 2],
    ])
    expect(states).toHaveLength(8)
  })

  test('a total-order model admits only prefixes of the issued operations', () => {
    // ext4 data=journal persists all operations in program order (Pillai
    // section 2.2.2), so at a crash point after op 1 the legal states are
    // {}, {op0} and {op0, op1} -- three, not four.
    const states = enumerateCrashStates(TRACE, {
      model: ext4Journal,
      bounds: { tornWrites: false, maxUnpersistedWindow: 8 },
    })

    const atOpOne = states.filter((s) => s.crashPoint === 1).map((s) => s.persisted)
    expect(atOpOne).toEqual([[], [0], [0, 1]])
  })

  test('operations older than the unpersisted window are present in every state', () => {
    // bounds.jsonc: "Operations older than the window are treated as persisted,
    // which is what a durability floor would eventually force anyway." Dropping
    // them instead would put an operation the target performed into no state at
    // all, and any acknowledgement that depended on it would look lost in every
    // image. That is a false positive manufactured by the enumerator.
    const long: Trace = {
      header: { version: 1, pid: 1 },
      events: Array.from({ length: 6 }, (_, i) =>
        event(i, { call: 'write', path: `/db/f${i}` }),
      ),
      markers: [],
    }

    const states = enumerateCrashStates(long, {
      model: ext4Ordered,
      bounds: { tornWrites: false, maxUnpersistedWindow: 2 },
    })

    // At the last crash point six operations are issued and only the newest two
    // are free, so the first four are in every state.
    const atEnd = states.filter((s) => s.crashPoint === 5)
    expect(atEnd.length).toBeGreaterThan(0)
    for (const state of atEnd) {
      expect(state.persisted).toEqual(expect.arrayContaining([0, 1, 2, 3]))
    }
  })

  test('does not enumerate a state that operates on a file it never created', () => {
    // A truncate of a file whose only creating write did not persist is not a
    // state any filesystem can produce: the metadata operation cannot reach the
    // disk before the inode it refers to. Enumerating it would either crash
    // materialization or, worse, silently materialize a different state than
    // the one the finding names.
    const created: Trace = {
      header: { version: 1, pid: 1 },
      events: [
        event(0, { call: 'write', path: '/db/scratch' }),
        event(1, { call: 'ftruncate', path: '/db/scratch', length: 128, returnValue: 0 }),
      ],
      markers: [],
    }

    const states = enumerateCrashStates(created, {
      model: ext4Ordered,
      bounds: { tornWrites: false, maxUnpersistedWindow: 8 },
    })

    const truncateWithoutFile = states.filter(
      (state) => state.persisted.includes(1) && !state.persisted.includes(0),
    )

    expect(truncateWithoutFile).toEqual([])
  })
})
