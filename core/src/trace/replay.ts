/**
 * Applies a trace to a directory, reproducing the file state the traced calls
 * produced. The target is not involved: payloads come from the content-addressed
 * store written during capture.
 *
 * Phase 2 uses the same application step over a subset of the trace to
 * materialize a crash state.
 */

import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Trace, TraceEvent } from './reader'

export type ReplayOptions = {
  /** Directory holding the payload objects captured with the trace. */
  casDir: string
  /** Directory the traced paths are relative to. */
  rootDir: string
  /** Directory the trace is applied to. */
  targetDir: string
}

/** Maps a path recorded during capture into the replay directory. */
function rebase(path: string, options: ReplayOptions): string {
  return join(options.targetDir, relative(options.rootDir, path))
}

function applyWrite(event: TraceEvent, options: ReplayOptions, bytes?: number): void {
  const whole = readFileSync(join(options.casDir, event.digest))
  // A torn write puts a sector-aligned prefix of the payload on disk. The
  // stored payload can be shorter than that prefix if the call was short.
  const payload = bytes === undefined ? whole : whole.subarray(0, Math.min(bytes, whole.length))
  const path = rebase(event.path, options)

  mkdirSync(dirname(path), { recursive: true })

  // Opened for positional writing. Append mode would ignore the offset the
  // event recorded.
  let fd: number
  try {
    fd = openSync(path, 'r+')
  } catch {
    fd = openSync(path, 'w+')
  }

  try {
    writeSync(fd, payload, 0, payload.length, event.offset)
  } finally {
    closeSync(fd)
  }
}

/** The subset of a trace that a crash state says reached the disk. */
export type Selection = {
  /** Operations present in full. */
  persisted: number[]
  /** Operations present as a prefix of their payload. */
  partial: { op: number; bytes: number }[]
}

/**
 * Applies only the operations a crash state says persisted, in submission
 * order. This is how a state becomes an image: same application step as a full
 * replay, restricted to the subset.
 */
export function replaySelection(trace: Trace, options: ReplayOptions, selection: Selection): void {
  mkdirSync(options.targetDir, { recursive: true })

  const tornBytes = new Map(selection.partial.map((entry) => [entry.op, entry.bytes]))
  const whole = new Set(selection.persisted)

  for (let index = 0; index < trace.events.length; index++) {
    if (!whole.has(index) && !tornBytes.has(index)) continue
    applySelected(trace.events[index]!, options, tornBytes.get(index))
  }
}

/** One operation of a crash state, torn to `bytes` when the state says so. */
function applySelected(event: TraceEvent, options: ReplayOptions, bytes?: number): void {
  switch (event.call) {
    case 'write':
    case 'pwrite':
    case 'writev':
      applyWrite(event, options, bytes)
      break
    case 'truncate':
    case 'ftruncate':
      truncateSync(rebase(event.path, options), event.length)
      break
    case 'mkdir':
      mkdirSync(rebase(event.path, options), { recursive: true })
      break
    case 'rename':
      renameSync(rebase(event.path, options), rebase(event.path2, options))
      break
    case 'link':
      linkSync(rebase(event.path, options), rebase(event.path2, options))
      break
    case 'unlink':
      rmSync(rebase(event.path, options), { force: true })
      break
    default:
      break
  }
}

/**
 * Applies events in submission order. Calls that only affect durability
 * (fsync, fdatasync, sync_file_range) do not change file contents and are
 * skipped; the persistence graph in Phase 2 is what interprets them.
 */
export function replayTrace(trace: Trace, options: ReplayOptions): void {
  mkdirSync(options.targetDir, { recursive: true })

  for (const event of trace.events) {
    if (event.returnValue < 0) continue
    applySelected(event, options)
  }
}
