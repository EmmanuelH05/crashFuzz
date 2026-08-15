/**
 * The oracle, as docs/model.md states it:
 *
 * > For crash point k, every logical operation acknowledged durable before k is
 * > readable after the target's own recovery with a matching value digest, and
 * > the target's own integrity check passes on the recovered database.
 *
 * Crash points and markers share one counter, so "before k" is a comparison of
 * submission stamps.
 */

import { describe, expect, test } from 'bun:test'
import { checkOracle } from '../../src/oracle/oracle'
import type { AckedOperation } from '../../src/oracle/acklog'

function acked(fields: Partial<AckedOperation>): AckedOperation {
  return {
    op: 1,
    kind: 'put',
    key: 'alpha',
    digest: 'aaaa',
    beganAt: 0,
    acknowledgedAt: 5,
    durable: true,
    ...fields,
  }
}

describe('checkOracle', () => {
  test('reports a durable acknowledged operation that recovery did not return', () => {
    const violations = checkOracle({
      crashStamp: 10,
      ackLog: [acked({ op: 1, key: 'alpha', digest: 'aaaa', acknowledgedAt: 5 })],
      recovery: { status: 'opened', integrityOk: true, values: new Map() },
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.violationClass).toBe('LOST_ACKED')
    expect(violations[0]!.key).toBe('alpha')
    expect(violations[0]!.expected).toBe('aaaa')
    expect(violations[0]!.actual).toBe('<absent>')
  })

  test('stays silent for everything the target never promised', () => {
    // Three ways an absent value is legal, all from docs/model.md. Each of
    // these firing would be a false positive, which the project treats as
    // costlier than a missed bug.
    const violations = checkOracle({
      crashStamp: 10,
      ackLog: [
        // Acknowledged, but not through the durable path. Known-legal
        // weirdness 2: a redb Durability::None commit may be absent after any
        // crash.
        acked({ op: 1, key: 'alpha', durable: false, acknowledgedAt: 5 }),
        // Never acknowledged: the workload was still inside the operation.
        acked({ op: 2, key: 'beta', acknowledgedAt: null }),
        // Acknowledged after the crash point, so it was never promised at k.
        acked({ op: 3, key: 'gamma', acknowledgedAt: 20 }),
        // Acknowledged at exactly the crash point. The crash sits after the
        // operation at that stamp was issued, so the ack raced the crash.
        acked({ op: 4, key: 'delta', acknowledgedAt: 10 }),
      ],
      recovery: { status: 'opened', integrityOk: true, values: new Map() },
    })

    expect(violations).toEqual([])
  })

  test('reports a durable acknowledged operation that came back with the wrong value', () => {
    // model.md: readable after recovery "with a matching value digest". A key
    // that survived with a stale value is a lost write that is harder to
    // notice, not a lesser one.
    const violations = checkOracle({
      crashStamp: 10,
      ackLog: [acked({ op: 1, key: 'alpha', digest: 'newvalue', acknowledgedAt: 5 })],
      recovery: {
        status: 'opened',
        integrityOk: true,
        values: new Map([['alpha', 'oldvalue']]),
      },
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]!.violationClass).toBe('LOST_ACKED')
    expect(violations[0]!.expected).toBe('newvalue')
    expect(violations[0]!.actual).toBe('oldvalue')
  })

  test('reports the target failing its own integrity check, and refusing to open', () => {
    // Two whole-database classes from docs/model.md. Neither is tied to a key,
    // so both carry a null op.
    // Both classes need something to have been promised before the crash: a
    // crash point that was promised nothing cannot have lost anything.
    const corrupt = checkOracle({
      crashStamp: 10,
      ackLog: [acked({ op: 1, key: 'alpha', acknowledgedAt: 5 })],
      recovery: {
        status: 'opened',
        integrityOk: false,
        values: new Map(),
        detail: 'wal index corrupt',
      },
    })

    // The corrupt database also lost the key it was holding, so both classes
    // fire: they are different claims about the same image.
    const corruptInvariant = corrupt.find((v) => v.violationClass === 'CORRUPT_INVARIANT')
    expect(corruptInvariant).toBeDefined()
    expect(corruptInvariant!.op).toBeNull()
    expect(corruptInvariant!.actual).toBe('wal index corrupt')
    expect(corrupt.some((v) => v.violationClass === 'LOST_ACKED')).toBe(true)

    const refused = checkOracle({
      crashStamp: 10,
      ackLog: [acked({ op: 1, key: 'alpha' })],
      recovery: { status: 'failed', detail: 'file is not a database' },
    })

    // One violation, not one per lost key. A database that will not open loses
    // every key, and reporting them separately would inflate the count with a
    // single root cause.
    expect(refused).toHaveLength(1)
    expect(refused[0]!.violationClass).toBe('RECOVERY_FAILED')
    expect(refused[0]!.actual).toBe('file is not a database')
  })

  test('reports no whole-database violation at a crash point that was promised nothing', () => {
    // Early crash points catch a target midway through creating its file. redb
    // refuses to open one with "I/O error: invalid data", which is correct: it
    // is not a database yet. The oracle in docs/model.md is about operations
    // acknowledged durable before the crash point, and when there are none,
    // nothing was promised and nothing can have been lost.
    //
    // Without this rule the campaign reports a finding for every target that
    // declines to open a half-created file, which is every well-behaved one.
    const violations = checkOracle({
      crashStamp: 7,
      ackLog: [acked({ op: 1, key: 'alpha', acknowledgedAt: 40 })],
      recovery: { status: 'failed', detail: 'open: I/O error: invalid data' },
    })

    expect(violations).toEqual([])
  })
})
