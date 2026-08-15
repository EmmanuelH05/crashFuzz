/**
 * The redb workload, under interception. redb is the primary target.
 *
 * Two things have to hold before any finding against redb means anything.
 * First, the ack markers must be durability claims: an operation committed at
 * `Durability::Immediate` is acknowledged only after a persistence call
 * returned. Second, an operation committed at `Durability::None` must be
 * acknowledged `durable=0`, because redb promises nothing about it and the
 * oracle must not expect it to survive. That is the in-workload negative
 * control from docs/model.md.
 *
 * Linux only, and the first run builds redb. Run with:
 *   bun run test:vm core/tests/integration/redb-workload.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildRedbWorkload, redbBinary } from '../../src/campaign/targets'
import { parseAckLog } from '../../src/oracle/acklog'
import { recoverRedb } from '../../src/oracle/recover'
import { parseTrace } from '../../src/trace/reader'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const SCRATCH = '/var/lib/crashfuzz/images'

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(SCRATCH, 'redb-'))

  const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, 'shim')])
  if (make.exitCode !== 0) throw new Error('building shim failed')

  buildRedbWorkload()
}, 900_000)

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function runWorkload(shape: string, operations: number) {
  const liveDir = mkdtempSync(join(workdir, `live-${shape}-`))
  const traceDir = mkdtempSync(join(workdir, `trace-${shape}-`))

  const run = Bun.spawnSync(
    [
      redbBinary('redb-workload'),
      join(liveDir, 'main.redb'),
      join(liveDir, 'crashfuzz.marker'),
      String(operations),
      shape,
    ],
    { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
  )
  if (run.exitCode !== 0) {
    throw new Error(`workload exited ${run.exitCode}: ${run.stderr.toString()}`)
  }

  return { liveDir, traceDir, pid: run.pid }
}

describe('redb-workload', () => {
  test('acks an Immediate commit after a persistence call and a None commit without one', async () => {
    const { traceDir, pid } = runWorkload('mixed', 4)
    const trace = parseTrace(await Bun.file(join(traceDir, `trace-${pid}.jsonl`)).text())
    const log = parseAckLog(trace)

    expect(log).toHaveLength(4)

    const durable = log.filter((operation) => operation.durable)
    const nonDurable = log.filter((operation) => !operation.durable)

    // The mixed shape alternates, so both kinds are present and the negative
    // control is actually exercised rather than assumed.
    expect(durable.length).toBeGreaterThan(0)
    expect(nonDurable.length).toBeGreaterThan(0)

    for (const operation of durable) {
      const persistedInFlight = trace.events.some(
        (event) =>
          (event.call === 'fsync' || event.call === 'fdatasync') &&
          event.returnValue === 0 &&
          event.index > operation.beganAt &&
          event.index < operation.acknowledgedAt!,
      )
      expect(persistedInFlight).toBe(true)
    }

    // The database is written through libc, which is what makes redb
    // observable at all. Verified in Phase 0 and re-checked here because the
    // whole project rests on it.
    expect(trace.events.some((event) => event.path.endsWith('main.redb'))).toBe(true)
    expect(trace.events.some((event) => event.path.endsWith('crashfuzz.marker'))).toBe(false)
  }, 300_000)

  test('recovery reads back every acknowledged value from an uncrashed database', async () => {
    // Two independently written digests must agree: the workload hashes what it
    // wrote in Rust, the query tool hashes what it read back. If they disagree
    // on a database that never crashed, every LOST_ACKED against redb is noise.
    const { liveDir, traceDir, pid } = runWorkload('single', 4)
    const trace = parseTrace(await Bun.file(join(traceDir, `trace-${pid}.jsonl`)).text())
    const log = parseAckLog(trace)
    const recovery = recoverRedb(join(liveDir, 'main.redb'))

    expect(recovery.status).toBe('opened')
    if (recovery.status !== 'opened') return

    expect(recovery.integrityOk).toBe(true)
    expect(log.length).toBe(4)
    for (const operation of log) {
      expect(recovery.values.get(operation.key)).toBe(operation.digest)
    }
  }, 300_000)
})
