/**
 * Reader for trace format v1.
 *
 * The shim writes one JSON object per line: a header, then events and markers.
 * See shim/src/shim.c for the producer.
 */

export const TRACE_VERSION = 1

/** Calls the shim records. Names are normalized across symbol variants. */
export type CallName =
  | 'open'
  | 'close'
  | 'write'
  | 'pwrite'
  | 'writev'
  | 'fsync'
  | 'fdatasync'
  | 'sync_file_range'
  | 'ftruncate'
  | 'truncate'
  | 'mkdir'
  | 'unlink'
  | 'link'
  | 'rename'

export type TraceEvent = {
  /** Stamp taken before the call was issued. */
  index: number
  /** Stamp taken after the call returned. */
  completionIndex: number
  call: CallName
  fd: number
  threadId: number
  path: string
  /** Destination operand of rename and link, empty otherwise. */
  path2: string
  offset: number
  length: number
  returnValue: number
  errno: number
  /** SHA-256 of the payload, empty for calls that carry none. */
  digest: string
}

export type TraceMarker = {
  index: number
  threadId: number
  text: string
}

export type Trace = {
  header: { version: number; pid: number }
  events: TraceEvent[]
  markers: TraceMarker[]
}

type RawRecord = Record<string, unknown>

function toEvent(record: RawRecord): TraceEvent {
  return {
    index: record.i as number,
    completionIndex: record.j as number,
    call: record.call as CallName,
    fd: record.fd as number,
    threadId: record.tid as number,
    path: record.path as string,
    path2: record.path2 as string,
    offset: record.off as number,
    length: record.len as number,
    returnValue: record.ret as number,
    errno: record.err as number,
    digest: record.dig as string,
  }
}

/**
 * Parses trace text. Segments from different processes interleave, so records
 * are sorted by submission stamp, which is unique across the whole run.
 */
export function parseTrace(text: string): Trace {
  const records = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawRecord)

  const header = records.find((r) => r.rec === 'header') as
    | { v: number; pid: number }
    | undefined
  if (header === undefined) {
    throw new Error('trace has no header record')
  }
  if (header.v !== TRACE_VERSION) {
    throw new Error(`trace version ${header.v} is not supported (expected ${TRACE_VERSION})`)
  }

  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index

  const events = records
    .filter((r) => r.rec === 'event')
    .map(toEvent)
    .sort(byIndex)

  const markers = records
    .filter((r) => r.rec === 'marker')
    .map((r) => ({
      index: r.i as number,
      threadId: r.tid as number,
      text: r.text as string,
    }))
    .sort(byIndex)

  return { header: { version: header.v, pid: header.pid }, events, markers }
}
