/**
 * Reproducer artifacts.
 *
 * CLAUDE.md: "Never claim a bug without a reproducer that runs on a machine you
 * have not touched." A finding is only as good as the artifact that carries it,
 * so the artifact is built and executed here rather than described.
 *
 * The mechanism is tested against a fabricated finding. There are no real
 * violations to package yet, and waiting for one before building the packaging
 * would mean debugging the packaging at the worst possible moment.
 *
 * Linux only. Run with: bun run test:vm core/tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createImage, withMount } from '../../src/image/image'
import { writeReproducer } from '../../src/oracle/reproducer'
import { replaySelection } from '../../src/trace/replay'
import { parseTrace } from '../../src/trace/reader'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const WORKLOAD = join(REPO_ROOT, 'targets', 'sqlite-workload', 'build', 'sqlite-workload')
const SCRATCH = '/var/lib/crashfuzz/images'

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(SCRATCH, 'repro-'))
  for (const target of ['shim', 'targets/sqlite-workload']) {
    const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, target)])
    if (make.exitCode !== 0) throw new Error(`building ${target} failed`)
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('writeReproducer', () => {
  test('packages an image and a script that replays the finding on its own', async () => {
    const liveDir = mkdtempSync(join(workdir, 'live-'))
    const traceDir = mkdtempSync(join(workdir, 'trace-'))

    const run = Bun.spawnSync(
      [WORKLOAD, join(liveDir, 'main.db'), join(liveDir, 'crashfuzz.marker'), '2'],
      { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
    )
    if (run.exitCode !== 0) throw new Error(`workload exited ${run.exitCode}`)

    const tracePath = join(traceDir, `trace-${run.pid}.jsonl`)
    const trace = parseTrace(await Bun.file(tracePath).text())

    // A state carrying every operation, so the packaged image is a database
    // that opens. What is fabricated here is the finding, not the image.
    const state = {
      crashPoint: trace.events.length - 1,
      persisted: trace.events.map((_, index) => index),
      partial: [],
    }

    const imagePath = join(workdir, 'finding.img')
    createImage({ imagePath, filesystem: 'ext4', sizeBytes: 512 * 1024 * 1024 })
    withMount(imagePath, (mountDir) => {
      replaySelection(trace, { casDir: join(traceDir, 'cas'), rootDir: liveDir, targetDir: mountDir }, state)
    })

    const outDir = join(workdir, 'artifact')
    writeReproducer(
      {
        signature: 'LOST_ACKED|missing:pwrite@main.db-wal',
        occurrences: 3,
        state,
        imagePath,
        violation: {
          violationClass: 'LOST_ACKED',
          crashStamp: trace.events.at(-1)!.index,
          op: 1,
          key: 'k1',
          expected: 'a'.repeat(64),
          actual: '<absent>',
        },
      },
      { outDir, tracePath, dbName: 'main.db', filesystem: 'ext4' },
    )

    expect(existsSync(join(outDir, 'state.img'))).toBe(true)
    expect(existsSync(join(outDir, 'README.md'))).toBe(true)

    // The trace prefix stops at the crash point: everything after it is not
    // part of what the reproducer claims happened.
    const prefix = parseTrace(readFileSync(join(outDir, 'trace-prefix.jsonl'), 'utf8'))
    expect(prefix.events.length).toBe(state.crashPoint + 1)

    // The script runs against the packaged image alone and reports what the
    // target actually returns, which is what a maintainer will run.
    const script = Bun.spawnSync(['bash', join(outDir, 'run.sh')], {
      env: { ...process.env, CRASHFUZZ_REPO: REPO_ROOT },
    })
    const output = script.stdout.toString() + script.stderr.toString()

    expect(script.exitCode).toBe(0)
    expect(output).toContain('integrity=ok')
    expect(output).toContain('k1')
  }, 300_000)
})
