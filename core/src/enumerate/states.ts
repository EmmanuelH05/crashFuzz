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
  /**
   * Crash points to enumerate, from selectCrashPoints. Every crash point in the
   * trace when omitted.
   */
  crashPoints?: number[]
}

export type CrashState = {
  /** Index into trace.events of the last operation issued before the crash. */
  crashPoint: number
  /** Indices of the operations present on disk in this state. */
  persisted: number[]
  /** Operations present as a sector-aligned prefix of their payload. */
  partial: { op: number; bytes: number }[]
}

/**
 * Sector size a torn write is truncated to. docs/model.md: no filesystem in the
 * sweep is reported to tear below a sector.
 */
const SECTOR_BYTES = 512

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
 * Sector-aligned prefix lengths of a write's payload, excluding nothing and the
 * whole payload, which are the state's two untorn cases. Only writes carry a
 * payload that can tear; a rename or an unlink is atomic per docs/model.md.
 */
function strictSectorPrefixes(event: TraceEvent): number[] {
  if (event.call !== 'write' && event.call !== 'pwrite' && event.call !== 'writev') return []

  const sectors = Math.ceil(event.length / SECTOR_BYTES)
  const prefixes: number[] = []
  for (let sector = 1; sector < sectors; sector++) {
    prefixes.push(sector * SECTOR_BYTES)
  }
  return prefixes
}

/**
 * Operations that need their target file to already exist on disk.
 *
 * Only the size-changing ones. A rename, link or unlink of a file whose data
 * writes did not persist is legal, and is the shape of the 2009 ext4 data loss
 * bug: `open(O_CREAT)` creates the inode, so the name can reach the disk while
 * the bytes behind it do not. Requiring data for those would delete the
 * positive control from the space, which is how this rule was caught.
 */
const NEEDS_EXISTING_FILE: ReadonlySet<string> = new Set(['truncate', 'ftruncate'])

/**
 * Whether every operation in a state could have reached the disk given the
 * others. A metadata operation cannot persist before the file it refers to
 * exists, so a state that truncates a file whose creating write it dropped is
 * not one any filesystem can produce.
 *
 * A path with no earlier mutation in the trace predates the trace, so nothing
 * is required of it.
 */
function existsOnDisk(events: TraceEvent[], persisted: number[]): boolean {
  const present = new Set(persisted)

  for (const index of persisted) {
    const event = events[index]!
    if (!NEEDS_EXISTING_FILE.has(event.call)) continue

    let earlier = false
    let earlierPersisted = false

    for (let j = 0; j < index; j++) {
      const candidate = events[j]!
      if (candidate.path !== event.path) continue
      if (!MUTATING.has(candidate.call) || candidate.returnValue < 0) continue

      earlier = true
      if (present.has(j)) earlierPersisted = true
    }

    if (earlier && !earlierPersisted) return false
  }

  return true
}

/**
 * Enumerates the legal crash states of a trace, one group per crash point.
 * Deterministic: states come out in a fixed order for a given trace, model and
 * bounds, so a run is reproducible without a seed.
 */
export function enumerateCrashStates(trace: Trace, options: EnumerateOptions): CrashState[] {
  const events = trace.events
  const states: CrashState[] = []

  const crashPoints =
    options.crashPoints ?? Array.from({ length: events.length }, (_, index) => index)

  for (const crashPoint of crashPoints) {
    const pinned = pinnedBy(events, crashPoint)

    const free: number[] = []
    for (let i = 0; i <= crashPoint; i++) {
      const event = events[i]!
      if (!MUTATING.has(event.call) || event.returnValue < 0) continue
      if (!pinned.has(i)) free.push(i)
    }

    const window = free.slice(-options.bounds.maxUnpersistedWindow)

    // Operations older than the window are treated as persisted, per
    // bounds.jsonc, which is what a durability floor would eventually force
    // anyway. Dropping them instead would leave an operation the target
    // performed out of every state, and any acknowledgement depending on it
    // would look lost in every image.
    const older = free.slice(0, Math.max(0, free.length - options.bounds.maxUnpersistedWindow))
    const alwaysPresent = [...new Set([...pinned, ...older])].sort((a, b) => a - b)

    if (options.model.totalOrder) {
      // Every operation persists in program order, so a legal state is a
      // prefix of the issued mutations.
      const issued = [...new Set([...alwaysPresent, ...window])].sort((a, b) => a - b)
      for (let take = 0; take <= issued.length; take++) {
        const persisted = issued.slice(0, take)
        if (alwaysPresent.every((index) => persisted.includes(index))) {
          states.push({ crashPoint, persisted, partial: [] })
        }
      }
      continue
    }

    for (let mask = 0; mask < 1 << window.length; mask++) {
      const persisted = [...alwaysPresent]
      for (let bit = 0; bit < window.length; bit++) {
        if (mask & (1 << bit)) persisted.push(window[bit]!)
      }
      persisted.sort((a, b) => a - b)
      if (!existsOnDisk(events, persisted)) continue
      states.push({ crashPoint, persisted, partial: [] })

      if (!options.bounds.tornWrites) continue

      // An operation absent from this state may instead be on disk as a
      // sector-aligned prefix of its payload. Whole and absent are the mask's
      // own two cases, so only the strict prefixes are added here.
      for (const op of window) {
        if (persisted.includes(op)) continue
        for (const bytes of strictSectorPrefixes(events[op]!)) {
          states.push({ crashPoint, persisted, partial: [{ op, bytes }] })
        }
      }
    }
  }

  return states
}
