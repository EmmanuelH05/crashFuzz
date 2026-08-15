/**
 * The SQLite control workload, under interception.
 *
 * The oracle rests entirely on the ack markers meaning what they claim: that
 * SQLite had returned from a durable commit before the marker was written. That
 * is checkable from the trace itself, because a `synchronous=FULL` commit in
 * WAL mode must issue an fsync, and the marker channel shares a counter with
 * the syscall stream. If an ack marker were ever stamped before the fsync that
 * makes its operation durable, every violation this tool reports would be
 * suspect.
 *
 * Linux only. Run with: bun run test:vm core/tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAckLog } from '../../src/oracle/acklog'
import { recoverSqlite } from '../../src/oracle/recover'
import { parseTrace } from '../../src/trace/reader'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const WORKLOAD = join(REPO_ROOT, 'targets', 'sqlite-workload', 'build', 'sqlite-workload')

/** Kept on the guest disk: the repo mount does not provide the semantics under test. */
const SCRATCH = '/var/lib/crashfuzz/images'

const OPERATIONS = 5

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(SCRATCH, 'sqlite-workload-'))

  for (const target of ['shim', 'targets/sqlite-workload']) {
    const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, target)])
    if (make.exitCode !== 0) {
      throw new Error(`building ${target} failed: ${make.stderr.toString()}`)
    }
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('sqlite-workload', () => {
  test('acknowledges each operation only after a persistence call returned', async () => {
    const dbPath = join(workdir, 'main.db')
    // The shim writes into this directory but does not create it.
    const traceDir = mkdtempSync(join(workdir, 'trace-'))

    const run = Bun.spawnSync(
      [WORKLOAD, dbPath, join(workdir, 'crashfuzz.marker'), String(OPERATIONS)],
      { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
    )
    if (run.exitCode !== 0) {
      throw new Error(`workload exited ${run.exitCode}: ${run.stderr.toString()}`)
    }

    const trace = parseTrace(await Bun.file(join(traceDir, `trace-${run.pid}.jsonl`)).text())
    const log = parseAckLog(trace)

    expect(log).toHaveLength(OPERATIONS)
    expect(log.every((operation) => operation.durable)).toBe(true)
    expect(log.every((operation) => operation.digest.length === 64)).toBe(true)

    // Every acknowledgement is preceded by an fsync issued after the operation
    // began. This is what makes the marker a durability claim rather than a
    // timestamp.
    for (const operation of log) {
      const persistedInFlight = trace.events.some(
        (event) =>
          (event.call === 'fsync' || event.call === 'fdatasync') &&
          event.returnValue === 0 &&
          event.index > operation.beganAt &&
          event.index < operation.acknowledgedAt!,
      )
      expect(persistedInFlight).toBe(true)
    }

    // The marker file is a side channel, not target I/O. Tracing it would put
    // operations in the persistence graph that SQLite never performed.
    expect(trace.events.some((event) => event.path.endsWith('crashfuzz.marker'))).toBe(false)

    // The database itself was written through libc, so it is observable.
    expect(trace.events.some((event) => event.path === dbPath)).toBe(true)
  })

  test('recovery reads back every acknowledged value from an uncrashed database', async () => {
    // The oracle compares digests produced by two different programs: the
    // workload hashes what it wrote, the query tool hashes what it read. If
    // those disagree on a database that never crashed, every LOST_ACKED this
    // tool ever reports is noise.
    const dbPath = join(workdir, 'clean.db')
    const traceDir = mkdtempSync(join(workdir, 'trace-'))

    const run = Bun.spawnSync(
      [WORKLOAD, dbPath, join(workdir, 'crashfuzz.marker'), String(OPERATIONS)],
      { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
    )
    if (run.exitCode !== 0) throw new Error(`workload exited ${run.exitCode}`)

    const trace = parseTrace(await Bun.file(join(traceDir, `trace-${run.pid}.jsonl`)).text())
    const log = parseAckLog(trace)
    const recovery = recoverSqlite(dbPath)

    expect(recovery.status).toBe('opened')
    if (recovery.status !== 'opened') return

    expect(recovery.integrityOk).toBe(true)
    for (const operation of log) {
      expect(recovery.values.get(operation.key)).toBe(operation.digest)
    }
  })

  test('recovery reports a file that is not a database instead of throwing', () => {
    // RECOVERY_FAILED has to be observable rather than fatal: a bounded run
    // materializes thousands of images and some of them will not open.
    const junk = join(workdir, 'junk.db')
    writeFileSync(junk, 'this is not a database')

    const recovery = recoverSqlite(junk)

    expect(recovery.status).toBe('failed')
    if (recovery.status !== 'failed') return
    expect(recovery.detail).not.toBe('')
  })
})
