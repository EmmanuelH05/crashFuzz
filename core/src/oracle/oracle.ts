/**
 * The oracle.
 *
 * docs/model.md states it operationally: for crash point k, every logical
 * operation acknowledged durable before k is readable after the target's own
 * recovery with a matching value digest, and the target's own integrity check
 * passes on the recovered database.
 *
 * The asymmetry in CLAUDE.md governs every judgement here. When it is unclear
 * whether a behavior is a violation, the default is that the model is wrong,
 * not that a bug was found, so this file reports only what the contract above
 * plainly forbids.
 */

import type { AckedOperation } from './acklog'

export type ViolationClass =
  | 'LOST_ACKED'
  | 'CORRUPT_INVARIANT'
  | 'RECOVERY_FAILED'
  | 'PHANTOM_UNACKED'

/** What the target did when pointed at a crash image. */
export type RecoveryResult =
  | {
      status: 'opened'
      /** The target's own integrity check. */
      integrityOk: boolean
      /** Key to value digest, as read back after recovery. */
      values: Map<string, string>
      detail?: string
    }
  | { status: 'failed'; detail: string }

export type OracleInput = {
  /** Submission stamp of the crash point. Markers share this counter. */
  crashStamp: number
  ackLog: AckedOperation[]
  recovery: RecoveryResult
}

export type Violation = {
  violationClass: ViolationClass
  crashStamp: number
  op: number | null
  key: string
  expected: string
  actual: string
}

/** Marks a value the recovered database did not have at all. */
const ABSENT = '<absent>'

/**
 * Operations the target had promised were durable before the crash. An
 * operation acknowledged at exactly the crash stamp is excluded: the crash
 * point sits after the operation at that stamp was issued, and an ack that
 * races the crash is not a promise the target has to keep.
 */
function promisedBefore(ackLog: AckedOperation[], crashStamp: number): AckedOperation[] {
  return ackLog.filter(
    (operation) =>
      operation.durable &&
      operation.acknowledgedAt !== null &&
      operation.acknowledgedAt < crashStamp,
  )
}

export function checkOracle(input: OracleInput): Violation[] {
  const violations: Violation[] = []

  if (input.recovery.status === 'failed') {
    // One violation, not one per acknowledged key. A database that will not
    // open loses all of them through a single root cause, and splitting that
    // into one finding per key would inflate the count.
    violations.push({
      violationClass: 'RECOVERY_FAILED',
      crashStamp: input.crashStamp,
      op: null,
      key: '',
      expected: '<opens and recovers>',
      actual: input.recovery.detail,
    })
    return violations
  }

  if (!input.recovery.integrityOk) {
    violations.push({
      violationClass: 'CORRUPT_INVARIANT',
      crashStamp: input.crashStamp,
      op: null,
      key: '',
      expected: '<integrity check passes>',
      actual: input.recovery.detail ?? '<integrity check failed>',
    })
  }

  for (const operation of promisedBefore(input.ackLog, input.crashStamp)) {
    const actual = input.recovery.values.get(operation.key)

    if (actual === undefined || actual !== operation.digest) {
      violations.push({
        violationClass: 'LOST_ACKED',
        crashStamp: input.crashStamp,
        op: operation.op,
        key: operation.key,
        expected: operation.digest,
        actual: actual ?? ABSENT,
      })
    }
  }

  return violations
}
