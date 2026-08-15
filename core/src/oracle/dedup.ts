/**
 * Root-cause signatures for violations.
 *
 * A bounded run enumerates tens of thousands of states and one bug fires in
 * many of them: every mask that omits the same write loses the same key. The
 * signature exists so those collapse into one finding.
 *
 * It is built from the earliest operation the acknowledgement depended on that
 * the state did not persist. That is the closest thing to a cause this tool can
 * name without speculating about the target's internals, which CLAUDE.md
 * forbids in a report. The mask itself is deliberately not part of the
 * signature: two masks that drop the same write are the same bug.
 *
 * Offsets are excluded for the same reason. The same missing write at page 4
 * and at page 900 is one bug, and including the offset would report it twice.
 */

import type { CrashState } from '../enumerate/states'
import type { Trace, TraceEvent } from '../trace/reader'
import type { AckedOperation } from './acklog'
import type { Violation } from './oracle'

/** Calls that put bytes or directory state on disk. */
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

/** `/db/main.db-wal` becomes `main.db-wal`. Directories vary between runs. */
function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

function describe(event: TraceEvent): string {
  return `${event.call}@${basename(event.path)}`
}

/**
 * The earliest mutation issued while the operation was in flight that this
 * state did not fully persist. A write present only as a torn prefix counts as
 * not persisted, and says so, because a half-written page and a missing page
 * are different failures.
 */
function earliestMissing(
  state: CrashState,
  trace: Trace,
  operation: AckedOperation,
): string {
  const persisted = new Set(state.persisted)
  const torn = new Set(state.partial.map((entry) => entry.op))
  const ackedAt = operation.acknowledgedAt ?? Number.POSITIVE_INFINITY

  for (let index = 0; index < trace.events.length; index++) {
    const event = trace.events[index]!
    if (!MUTATING.has(event.call) || event.returnValue < 0) continue
    if (event.index < operation.beganAt || event.index > ackedAt) continue

    if (torn.has(index)) return `torn:${describe(event)}`
    if (!persisted.has(index)) return `missing:${describe(event)}`
  }

  return 'missing:none'
}

/**
 * A stable identity for the root cause of a violation. Two violations with the
 * same signature are one finding.
 */
export function signatureOf(
  violation: Violation,
  state: CrashState,
  trace: Trace,
  operation: AckedOperation,
): string {
  return [violation.violationClass, earliestMissing(state, trace, operation)].join('|')
}
