/**
 * Deduplication by root-cause signature.
 *
 * A bounded run enumerates tens of thousands of states, and one bug fires in
 * many of them: every mask that happens to omit the same write loses the same
 * key. Reporting those separately would turn one finding into a thousand and
 * make triage impossible.
 *
 * The signature is structural. It is built from what the state left unpersisted
 * that the acknowledgement depended on, not from the violation's message, and
 * not from the mask, since two different masks that drop the same write are the
 * same bug.
 */

import { describe, expect, test } from 'bun:test'
import { signatureOf } from '../../src/oracle/dedup'
import type { Violation } from '../../src/oracle/oracle'
import type { AckedOperation } from '../../src/oracle/acklog'
import type { CrashState } from '../../src/enumerate/states'
import type { Trace, TraceEvent } from '../../src/trace/reader'

function event(index: number, fields: Partial<TraceEvent>): TraceEvent {
  return {
    index,
    completionIndex: index + 100,
    call: 'write',
    fd: 3,
    threadId: 1,
    path: '/db/main.db',
    path2: '',
    offset: 0,
    length: 4096,
    returnValue: 4096,
    errno: 0,
    digest: 'a'.repeat(64),
    ...fields,
  }
}

/**
 * op 0 writes the WAL, op 1 writes the main database, op 2 fsyncs, and the
 * driver acknowledges at stamp 3.
 */
const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: [
    event(0, { path: '/db/main.db-wal' }),
    event(1, { path: '/db/main.db' }),
    event(2, { call: 'fsync', path: '/db/main.db-wal', length: 0, returnValue: 0 }),
  ],
  markers: [],
}

const OPERATION: AckedOperation = {
  op: 1,
  kind: 'put',
  key: 'alpha',
  digest: 'aaaa',
  beganAt: 0,
  acknowledgedAt: 3,
  durable: true,
}

const VIOLATION: Violation = {
  violationClass: 'LOST_ACKED',
  crashStamp: 3,
  op: 1,
  key: 'alpha',
  expected: 'aaaa',
  actual: '<absent>',
}

function state(persisted: number[], partial: CrashState['partial'] = []): CrashState {
  return { crashPoint: 2, persisted, partial }
}

describe('signatureOf', () => {
  test('collapses states that dropped the same write and separates ones that did not', () => {
    // Both states are missing the WAL write at op 0. They differ in whether the
    // main database write also landed, which is not the cause of the loss.
    const missingWal = signatureOf(VIOLATION, state([1]), TRACE, OPERATION)
    const missingWalAndDb = signatureOf(VIOLATION, state([]), TRACE, OPERATION)

    expect(missingWal).toBe(missingWalAndDb)

    // This state has the WAL write but not the main database write, so the
    // earliest thing the acknowledgement depended on and did not get is
    // different, and it is a different signature.
    const missingDb = signatureOf(VIOLATION, state([0]), TRACE, OPERATION)

    expect(missingDb).not.toBe(missingWal)

    // The signature names the operation it blames, so a reader can act on it
    // without opening the image.
    expect(missingWal).toContain('LOST_ACKED')
    expect(missingWal).toContain('main.db-wal')
  })
})
