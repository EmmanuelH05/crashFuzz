/**
 * The acknowledgement log: what the workload driver promised, and when.
 *
 * docs/model.md fixes the oracle's input as "the workload driver's logical
 * operation log, correlated to the syscall stream by the marker channel". A
 * syscall trace cannot say when a target acknowledged durability; only the
 * driver knows when its own commit call returned. The driver writes a marker on
 * either side of each logical operation and the shim stamps it into the same
 * counter the syscalls use, which is what makes the two streams comparable.
 *
 * Marker text is space-separated `key=value` pairs:
 *
 *   op=1 phase=begin kind=put key=alpha
 *   op=1 phase=ack kind=put key=alpha digest=<sha256 of the value> durable=1
 *
 * `durable=1` means the driver used the target's durable-commit path, so the
 * oracle is entitled to expect the operation to survive a crash. `durable=0` is
 * an in-workload negative control: the operation may be absent after any crash
 * and its absence is not a violation. See docs/model.md, target configuration.
 */

import type { Trace } from '../trace/reader'

export type AckedOperation = {
  /** The driver's own operation number. */
  op: number
  kind: string
  key: string
  /** SHA-256 of the value the driver wrote, empty until the operation acks. */
  digest: string
  /** Submission stamp of the begin marker. */
  beganAt: number
  /** Submission stamp of the ack marker, null if the operation never acked. */
  acknowledgedAt: number | null
  /** Whether the driver used the target's durable-commit path. */
  durable: boolean
}

function fields(text: string): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const token of text.split(/\s+/)) {
    const split = token.indexOf('=')
    if (split <= 0) continue
    pairs.set(token.slice(0, split), token.slice(split + 1))
  }
  return pairs
}

/**
 * Reads the marker channel into one record per logical operation, in the order
 * the operations began. An operation with no ack marker is reported with
 * `acknowledgedAt: null` rather than dropped: the oracle must be able to tell
 * "never promised" apart from "not in the log".
 */
export function parseAckLog(trace: Trace): AckedOperation[] {
  const operations = new Map<number, AckedOperation>()

  for (const marker of trace.markers) {
    const pairs = fields(marker.text)
    const op = Number(pairs.get('op'))
    if (!Number.isFinite(op)) continue

    if (pairs.get('phase') === 'begin') {
      operations.set(op, {
        op,
        kind: pairs.get('kind') ?? '',
        key: pairs.get('key') ?? '',
        digest: '',
        beganAt: marker.index,
        acknowledgedAt: null,
        durable: false,
      })
      continue
    }

    if (pairs.get('phase') === 'ack') {
      const existing = operations.get(op)
      // An ack with no begin is a driver bug, not a target bug. Recording it
      // with a begin stamp of its own keeps the log total rather than silently
      // dropping an operation the oracle would then never check.
      const record = existing ?? {
        op,
        kind: pairs.get('kind') ?? '',
        key: pairs.get('key') ?? '',
        digest: '',
        beganAt: marker.index,
        acknowledgedAt: null,
        durable: false,
      }

      record.digest = pairs.get('digest') ?? ''
      record.acknowledgedAt = marker.index
      record.durable = pairs.get('durable') === '1'
      operations.set(op, record)
    }
  }

  return [...operations.values()].sort((a, b) => a.beganAt - b.beganAt)
}
