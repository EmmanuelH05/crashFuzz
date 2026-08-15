/**
 * Trace parsing. Pure logic over trace text, so it runs on the host.
 */

import { describe, expect, test } from 'bun:test'
import { parseTrace } from '../../src/trace/reader'

const HEADER = '{"rec":"header","v":1,"pid":42}'

function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    rec: 'event',
    i: 0,
    j: 1,
    call: 'write',
    fd: 3,
    tid: 42,
    path: '/db',
    path2: '',
    off: 0,
    len: 4,
    ret: 4,
    err: 0,
    dig: 'a'.repeat(64),
    ...fields,
  })
}

describe('parseTrace', () => {
  test('rejects a trace whose version it does not implement', () => {
    const text = `{"rec":"header","v":2,"pid":42}\n`
    expect(() => parseTrace(text)).toThrow('trace version 2')
  })

  test('returns events and markers in submission order across segments', () => {
    const text = [
      HEADER,
      event({ i: 4, j: 5, call: 'fsync', len: 0, ret: 0, dig: '' }),
      '{"rec":"marker","i":2,"tid":42,"text":"op=1 phase=begin"}',
      event({ i: 0, j: 1, call: 'write' }),
      '',
    ].join('\n')

    const trace = parseTrace(text)

    expect(trace.events.map((e) => [e.index, e.call])).toEqual([
      [0, 'write'],
      [4, 'fsync'],
    ])
    expect(trace.markers).toEqual([{ index: 2, threadId: 42, text: 'op=1 phase=begin' }])
  })
})
