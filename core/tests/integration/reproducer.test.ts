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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      {
        outDir,
        tracePath,
        dbName: 'main.db',
        filesystem: 'ext4',
        queryCommand: join(REPO_ROOT, 'targets', 'sqlite-workload', 'build', 'sqlite-query'),
      },
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

  test('asks the target the finding came from, not whichever target is hardcoded', () => {
    // Found by running a redb artifact: the script asked SQLite's query tool
    // about a redb database and reported "file is not a database". An artifact
    // that queries the wrong target does not merely fail to reproduce, it
    // reports a confident and completely false observation, which is the worst
    // thing this project can hand a maintainer.
    const outDir = join(workdir, 'artifact-target')
    const tracePath = join(workdir, 'trace-for-target.jsonl')
    writeFileSync(tracePath, `${JSON.stringify({ rec: 'header', v: 1, pid: 1 })}\n`)

    writeReproducer(
      {
        signature: 'RECOVERY_FAILED|missing:ftruncate@main.redb',
        occurrences: 11,
        state: { crashPoint: 0, persisted: [], partial: [] },
        imagePath: join(workdir, 'finding.img'),
        violation: {
          violationClass: 'RECOVERY_FAILED',
          crashStamp: 1,
          op: null,
          key: '',
          expected: '<opens and recovers>',
          actual: 'assertion failed',
        },
      },
      {
        outDir,
        tracePath,
        dbName: 'main.redb',
        filesystem: 'ext4',
        queryCommand: '/bin/echo queried-by-the-right-target',
      },
    )

    const script = Bun.spawnSync(['bash', join(outDir, 'run.sh')], {
      env: { ...process.env, CRASHFUZZ_REPO: REPO_ROOT },
    })

    expect(script.stdout.toString()).toContain('queried-by-the-right-target')
  }, 300_000)

  test('builds the query tool from source when it is not already built at the packaged path', () => {
    // On a fresh clone the query binary this artifact was built against does
    // not exist yet. CLAUDE.md and the Phase 5 gate both require the artifact
    // to run "from a fresh clone with one command", so the script has to build
    // it rather than fail on a path that only ever existed on our machine.
    const outDir = join(workdir, 'artifact-build')
    const tracePath = join(workdir, 'trace-for-build.jsonl')
    writeFileSync(tracePath, `${JSON.stringify({ rec: 'header', v: 1, pid: 1 })}\n`)

    const notYetBuilt = join(workdir, 'not-yet-built-tool')
    rmSync(notYetBuilt, { force: true })

    writeReproducer(
      {
        signature: 'RECOVERY_FAILED|missing:ftruncate@main.redb',
        occurrences: 1,
        state: { crashPoint: 0, persisted: [], partial: [] },
        imagePath: join(workdir, 'finding.img'),
        violation: {
          violationClass: 'RECOVERY_FAILED',
          crashStamp: 1,
          op: null,
          key: '',
          expected: '<opens and recovers>',
          actual: 'assertion failed',
        },
      },
      {
        outDir,
        tracePath,
        dbName: 'main.redb',
        filesystem: 'ext4',
        queryCommand: notYetBuilt,
        buildCommand: `printf '#!/bin/sh\\necho queried-by-the-built-target\\n' > "${notYetBuilt}" && chmod +x "${notYetBuilt}"`,
      },
    )

    expect(existsSync(notYetBuilt)).toBe(false)

    const script = Bun.spawnSync(['bash', join(outDir, 'run.sh')], {
      env: { ...process.env, CRASHFUZZ_REPO: REPO_ROOT },
    })

    expect(script.stdout.toString()).toContain('queried-by-the-built-target')
  }, 300_000)

  test('runs a build command that references a source path containing a space', () => {
    // The template embeds buildCommand inside build="...", so a build command
    // that itself contains double quotes (as one referencing $repo needs to)
    // can break out of that quoting. This stays hidden as long as $repo has
    // no spaces in it; a repo cloned somewhere like "/Users/a b/crashFuzz"
    // would expose it. The build's output path stays space-free, matching
    // where the real build command actually writes it (a fixed VM path); the
    // space sits in the source side of the command, the part the escaping
    // has to survive.
    const spacedSourceDir = join(workdir, 'a dir with spaces', 'src')
    mkdirSync(spacedSourceDir, { recursive: true })
    writeFileSync(join(spacedSourceDir, 'payload'), 'built-from-a-spaced-path')

    const notYetBuilt = join(workdir, 'not-yet-built-tool-spaced')
    const outDir = join(workdir, 'artifact-build-spaced')
    const tracePath = join(workdir, 'trace-for-build-spaced.jsonl')
    writeFileSync(tracePath, `${JSON.stringify({ rec: 'header', v: 1, pid: 1 })}\n`)

    writeReproducer(
      {
        signature: 'RECOVERY_FAILED|missing:ftruncate@main.redb',
        occurrences: 1,
        state: { crashPoint: 0, persisted: [], partial: [] },
        imagePath: join(workdir, 'finding.img'),
        violation: {
          violationClass: 'RECOVERY_FAILED',
          crashStamp: 1,
          op: null,
          key: '',
          expected: '<opens and recovers>',
          actual: 'assertion failed',
        },
      },
      {
        outDir,
        tracePath,
        dbName: 'main.redb',
        filesystem: 'ext4',
        queryCommand: notYetBuilt,
        // test -f only succeeds if the spaced path survives as one argument.
        // Broken escaping splits it and this &&-chain never reaches printf.
        buildCommand: `test -f "${spacedSourceDir}/payload" && printf '#!/bin/sh\\necho built-from-a-spaced-path\\n' > "${notYetBuilt}" && chmod +x "${notYetBuilt}"`,
      },
    )

    const script = Bun.spawnSync(['bash', join(outDir, 'run.sh')], {
      env: { ...process.env, CRASHFUZZ_REPO: REPO_ROOT },
    })

    expect(script.stdout.toString()).toContain('built-from-a-spaced-path')
  }, 300_000)
})
