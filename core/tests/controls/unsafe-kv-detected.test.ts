/**
 * The end-to-end positive control.
 *
 * "The control target reports zero violations" is only meaningful alongside
 * evidence that the oracle fires at all. An oracle that never fires passes the
 * clean run trivially, and would pass it just as happily if the whole pipeline
 * were broken.
 *
 * So this runs a deliberately unsafe application through the same pipeline. It
 * is the update protocol from Pillai et al. §2.2.2 with the fsync left out:
 * write a temporary file, rename it over the real one, and tell the caller the
 * value is durable. On a filesystem that does not order the append before the
 * rename, a crash can leave the new name pointing at no data, and the value the
 * application promised is gone. The tool must find that.
 *
 * The bug is in the workload, not in xfs. That is the point: this project tests
 * applications, not filesystems.
 *
 * Linux only, and slow. Run with: bun run test:vm core/tests/controls
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runCampaign } from '../../src/campaign/campaign'
import { xfs } from '../../src/graph/models'
import { recoverFileKv } from '../../src/oracle/recover'
import { writeReproducer } from '../../src/oracle/reproducer'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const WORKLOAD = join(REPO_ROOT, 'targets', 'unsafe-kv', 'build', 'unsafe-kv')
const SCRATCH = '/var/lib/crashfuzz/images'

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(SCRATCH, 'unsafe-'))
  for (const target of ['shim', 'targets/unsafe-kv']) {
    const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, target)])
    if (make.exitCode !== 0) {
      throw new Error(`building ${target} failed: ${make.stderr.toString()}`)
    }
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('unsafe rename protocol', () => {
  test('is detected, and the finding packages into a runnable reproducer', () => {
    const liveDir = mkdtempSync(join(workdir, 'live-'))
    const traceDir = mkdtempSync(join(workdir, 'trace-'))

    const run = Bun.spawnSync([WORKLOAD, liveDir, join(liveDir, 'crashfuzz.marker'), '2'], {
      env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir },
    })
    if (run.exitCode !== 0) throw new Error(`workload exited ${run.exitCode}`)

    const tracePath = join(traceDir, `trace-${run.pid}.jsonl`)
    const result = runCampaign({
      tracePath,
      casDir: join(traceDir, 'cas'),
      rootDir: liveDir,
      imageDir: join(workdir, 'images'),
      dbName: 'k1',
      model: xfs,
      filesystem: 'xfs',
      seed: 1,
      recover: recoverFileKv,
    })

    expect(result.statesTested).toBeGreaterThan(0)

    const lost = result.findings.filter((f) => f.violation.violationClass === 'LOST_ACKED')
    expect(lost.length).toBeGreaterThan(0)

    // The finding has to survive packaging, or it cannot be reported to anyone.
    const outDir = join(workdir, 'artifact')
    writeReproducer(lost[0]!, { outDir, tracePath, dbName: 'k1', filesystem: 'xfs' })

    expect(existsSync(join(outDir, 'state.img'))).toBe(true)
    expect(existsSync(join(outDir, 'finding.json'))).toBe(true)
  }, 900_000)
})
