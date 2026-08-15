/**
 * The acknowledgement log.
 *
 * docs/model.md: "Acknowledgement comes from the workload driver's logical
 * operation log, correlated to the syscall stream by the marker channel." The
 * oracle needs to know, at a given crash point, which logical operations the
 * target had already promised were durable. A syscall trace alone cannot say
 * that; only the driver knows when its own commit call returned.
 *
 * Marker text is `key=value` pairs. An operation is acknowledged durable at the
 * submission stamp of its `phase=ack` marker, which the driver writes only
 * after the target's durable-commit call has returned.
 */

import { describe, expect, test } from 'bun:test'
import { parseAckLog } from '../../src/oracle/acklog'
import type { Trace } from '../../src/trace/reader'

const TRACE: Trace = {
  header: { version: 1, pid: 1 },
  events: [],
  markers: [
    { index: 0, threadId: 1, text: 'op=1 phase=begin kind=put key=alpha' },
    { index: 5, threadId: 1, text: 'op=1 phase=ack kind=put key=alpha digest=aaaa durable=1' },
    { index: 6, threadId: 1, text: 'op=2 phase=begin kind=put key=beta' },
    // No ack: the workload was still inside this operation when it ended.
    { index: 9, threadId: 1, text: 'op=3 phase=begin kind=put key=gamma' },
    { index: 12, threadId: 1, text: 'op=3 phase=ack kind=put key=gamma digest=cccc durable=0' },
  ],
}

describe('parseAckLog', () => {
  test('records what each operation promised and when it was promised', () => {
    const log = parseAckLog(TRACE)

    expect(log).toEqual([
      {
        op: 1,
        kind: 'put',
        key: 'alpha',
        digest: 'aaaa',
        beganAt: 0,
        acknowledgedAt: 5,
        durable: true,
      },
      {
        op: 2,
        kind: 'put',
        key: 'beta',
        digest: '',
        beganAt: 6,
        acknowledgedAt: null,
        durable: false,
      },
      {
        op: 3,
        kind: 'put',
        key: 'gamma',
        digest: 'cccc',
        beganAt: 9,
        acknowledgedAt: 12,
        durable: false,
      },
    ])
  })
})
