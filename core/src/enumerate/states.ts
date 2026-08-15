/**
 * Crash state enumeration.
 *
 * A crash point sits after an operation was issued. At a crash point, each
 * operation issued so far is either persisted or not; the set of legal
 * combinations is constrained by the filesystem model in docs/model.md.
 */

import type { FilesystemModel } from '../graph/models'
import type { Trace, TraceEvent } from '../trace/reader'

export type Bounds = {
  /** Model partial writes at sector granularity. Off for the hand-computed table. */
  tornWrites: boolean
  /** Largest number of unpersisted operations enumerated exhaustively. */
  maxUnpersistedWindow: number
}

export type EnumerateOptions = {
  model: FilesystemModel
  bounds: Bounds
}

export type CrashState = {
  /** Index into trace.events of the last operation issued before the crash. */
  crashPoint: number
  /** Indices of the operations present on disk in this state. */
  persisted: number[]
}

/** Calls that change file contents or the directory tree. */
const MUTATING: ReadonlySet<string> = new Set([
  'write',
  'pwrite',
  'writev',
  'truncate',
  'ftruncate',
  'mkdir',
  'unlink',
  'link',
  'rename',
])

const PERSISTENCE: ReadonlySet<string> = new Set(['fsync', 'fdatasync', 'sync_file_range'])

/**
 * Operations that a returned persistence call forces to be present. An fsync
 * pins every earlier mutation of the same file; it says nothing about others.
 */
function pinnedBy(events: TraceEvent[], upto: number): Set<number> {
  const pinned = new Set<number>()

  for (let i = 0; i <= upto; i++) {
    const event = events[i]!
    if (!PERSISTENCE.has(event.call) || event.returnValue < 0) continue

    for (let j = 0; j < i; j++) {
      const earlier = events[j]!
      if (MUTATING.has(earlier.call) && earlier.path === event.path) {
        pinned.add(j)
      }
    }
  }

  return pinned
}

/**
 * Enumerates the legal crash states of a trace, one group per crash point.
 * Deterministic: states come out in a fixed order for a given trace, model and
 * bounds, so a run is reproducible without a seed.
 */
export function enumerateCrashStates(trace: Trace, options: EnumerateOptions): CrashState[] {
  const events = trace.events
  const states: CrashState[] = []

  for (let crashPoint = 0; crashPoint < events.length; crashPoint++) {
    const pinned = pinnedBy(events, crashPoint)

    const free: number[] = []
    for (let i = 0; i <= crashPoint; i++) {
      const event = events[i]!
      if (!MUTATING.has(event.call) || event.returnValue < 0) continue
      if (!pinned.has(i)) free.push(i)
    }

    const window = free.slice(-options.bounds.maxUnpersistedWindow)
    const alwaysPresent = [...pinned].sort((a, b) => a - b)

    if (options.model.totalOrder) {
      // Every operation persists in program order, so a legal state is a
      // prefix of the issued mutations.
      const issued = [...new Set([...alwaysPresent, ...window])].sort((a, b) => a - b)
      for (let take = 0; take <= issued.length; take++) {
        const persisted = issued.slice(0, take)
        if (alwaysPresent.every((index) => persisted.includes(index))) {
          states.push({ crashPoint, persisted })
        }
      }
      continue
    }

    for (let mask = 0; mask < 1 << window.length; mask++) {
      const persisted = [...alwaysPresent]
      for (let bit = 0; bit < window.length; bit++) {
        if (mask & (1 << bit)) persisted.push(window[bit]!)
      }
      states.push({ crashPoint, persisted: persisted.sort((a, b) => a - b) })
    }
  }

  return states
}
