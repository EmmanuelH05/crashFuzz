/**
 * The control run.
 *
 * CLAUDE.md: "Control target (SQLite) reports zero violations across the full
 * bounded space. If it does not, the oracle is broken. Fix the oracle. Do not
 * report the finding."
 *
 * SQLite in WAL mode at synchronous=FULL is the most heavily tested crash
 * consistency implementation available. A violation here is overwhelmingly
 * likely to be this project's model or oracle rather than SQLite's bug, so this
 * test is not a test of SQLite. It is a test of us, and the only result that
 * means anything is zero.
 *
 * Linux only, and slow: every state is a real filesystem on a loop device.
 * Run with: bun run test:vm core/tests/controls
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runCampaign } from '../../src/campaign/campaign'
import { ext4Ordered } from '../../src/graph/models'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const WORKLOAD = join(REPO_ROOT, 'targets', 'sqlite-workload', 'build', 'sqlite-workload')

const SCRATCH = '/var/lib/crashfuzz/images'

/** Three operations: within maxExhaustiveWorkloadOps, so no crash point is sampled away. */
const OPERATIONS = 3

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(SCRATCH, 'control-'))

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

describe('SQLite control', () => {
  test('reports zero violations across the bounded crash state space', () => {
    const liveDir = mkdtempSync(join(workdir, 'live-'))
    const traceDir = mkdtempSync(join(workdir, 'trace-'))

    const run = Bun.spawnSync(
      [
        WORKLOAD,
        join(liveDir, 'main.db'),
        join(liveDir, 'crashfuzz.marker'),
        String(OPERATIONS),
      ],
      { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
    )
    if (run.exitCode !== 0) throw new Error(`workload exited ${run.exitCode}`)

    const result = runCampaign({
      tracePath: join(traceDir, `trace-${run.pid}.jsonl`),
      casDir: join(traceDir, 'cas'),
      rootDir: liveDir,
      imageDir: join(workdir, 'images'),
      dbName: 'main.db',
      model: ext4Ordered,
      filesystem: 'ext4',
      seed: 1,
    })

    // A run that tested nothing is not a clean run.
    expect(result.statesTested).toBeGreaterThan(0)
    expect(result.findings).toEqual([])
  }, 900_000)
})
