#!/usr/bin/env bun
/**
 * The Phase 4 campaign.
 *
 * Runs every filesystem in the sweep against every workload shape on the
 * primary target, and writes the results table plus one reproducer per distinct
 * finding.
 *
 *   bun run campaign [operations] [seed]
 *
 * Writes docs/results.md and plots/data/campaign.csv. Reproducers land in
 * /var/lib/crashfuzz/findings, which is on the guest disk rather than in the
 * repo because a crash image is half a gigabyte of sparse file.
 *
 * Slow by construction: every state is a real filesystem on a loop device, made
 * and mounted twice. Expect on the order of a hundred states per minute.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCampaign } from '../src/campaign/campaign'
import { resultsTable } from '../src/campaign/results'
import type { SweepRow } from '../src/campaign/results'
import { sweepPlan } from '../src/campaign/sweep'
import { buildRedbWorkload, redbBinary } from '../src/campaign/targets'
import { recoverRedb } from '../src/oracle/recover'
import { writeReproducer } from '../src/oracle/reproducer'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')
const SCRATCH = '/var/lib/crashfuzz'
const DB_NAME = 'main.redb'

function captureTrace(shape: string, operations: number, workdir: string) {
  const liveDir = mkdtempSync(join(workdir, `live-${shape}-`))
  const traceDir = mkdtempSync(join(workdir, `trace-${shape}-`))

  const run = Bun.spawnSync(
    [
      redbBinary('redb-workload'),
      join(liveDir, DB_NAME),
      join(liveDir, 'crashfuzz.marker'),
      String(operations),
      shape,
    ],
    { env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir } },
  )

  if (run.exitCode !== 0) {
    throw new Error(`workload ${shape} exited ${run.exitCode}: ${run.stderr.toString()}`)
  }

  return {
    liveDir,
    casDir: join(traceDir, 'cas'),
    tracePath: join(traceDir, `trace-${run.pid}.jsonl`),
  }
}

function main(argv: string[]): number {
  const operations = Number(argv[2] ?? 8)
  const seed = Number(argv[3] ?? 1)

  const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, 'shim')])
  if (make.exitCode !== 0) throw new Error('building shim failed')
  buildRedbWorkload()

  const workdir = mkdtempSync(join(SCRATCH, 'images', 'campaign-'))
  const findingsRoot = join(SCRATCH, 'findings')
  rmSync(findingsRoot, { recursive: true, force: true })
  mkdirSync(findingsRoot, { recursive: true })

  const rows: SweepRow[] = []
  const started = Bun.nanoseconds()

  // The trace is captured once per shape and reused across filesystems: the
  // syscalls redb issues do not depend on the filesystem it is running on, and
  // recapturing would make the rows differ by more than the one variable the
  // sweep is meant to isolate.
  const traces = new Map<string, ReturnType<typeof captureTrace>>()

  for (const run of sweepPlan()) {
    if (!traces.has(run.shape)) {
      traces.set(run.shape, captureTrace(run.shape, operations, workdir))
    }
    const capture = traces.get(run.shape)!

    const result = runCampaign({
      tracePath: capture.tracePath,
      casDir: capture.casDir,
      rootDir: capture.liveDir,
      imageDir: join(workdir, `img-${run.config.name}-${run.shape}`),
      dbName: DB_NAME,
      model: run.config.model,
      filesystem: run.config.filesystem,
      mountOptions: run.config.mountOptions,
      seed,
      recover: (mountDir) => recoverRedb(join(mountDir, DB_NAME)),
    })

    for (const finding of result.findings) {
      writeReproducer(finding, {
        outDir: join(findingsRoot, `${run.config.name}-${run.shape}-${finding.signature.replace(/[^a-zA-Z0-9]+/g, '-')}`),
        tracePath: capture.tracePath,
        dbName: DB_NAME,
        filesystem: run.config.filesystem,
        queryCommand: redbBinary('redb-query'),
      })
    }

    rows.push({
      configName: run.config.name,
      filesystem: run.config.filesystem,
      mountOptions: run.config.mountOptions,
      shape: run.shape,
      crashPointsTested: result.crashPointsTested,
      statesTested: result.statesTested,
      findings: result.findings.map((finding) => ({
        signature: finding.signature,
        count: finding.occurrences,
      })),
    })

    console.log(
      `${run.config.name.padEnd(13)} ${run.shape.padEnd(11)} ` +
        `states=${String(result.statesTested).padStart(5)} findings=${result.findings.length}`,
    )
  }

  const elapsedSeconds = (Bun.nanoseconds() - started) / 1e9
  const totalStates = rows.reduce((total, row) => total + row.statesTested, 0)
  const totalFindings = rows.reduce((total, row) => total + row.findings.length, 0)

  const csv = [
    'filesystem,mount_options,shape,crash_points,states,findings',
    ...rows.map(
      (row) =>
        `${row.filesystem},${row.mountOptions ?? 'default'},${row.shape},` +
        `${row.crashPointsTested},${row.statesTested},${row.findings.length}`,
    ),
  ].join('\n')

  mkdirSync(join(REPO_ROOT, 'plots', 'data'), { recursive: true })
  writeFileSync(join(REPO_ROOT, 'plots', 'data', 'campaign.csv'), `${csv}\n`)

  const signatures = [...new Set(rows.flatMap((row) => row.findings.map((f) => f.signature)))]

  writeFileSync(
    join(REPO_ROOT, 'docs', 'results.md'),
    [
      '# Campaign results',
      '',
      '> Generated by `bun run campaign`. Regenerate rather than edit.',
      '',
      `Primary target: redb. Operations per workload: ${operations}. Seed: ${seed}.`,
      `Wall clock: ${elapsedSeconds.toFixed(0)}s.`,
      '',
      'Bounds are in `core/src/enumerate/bounds.jsonc`; what this run did not cover is in',
      '`docs/coverage.md`.',
      '',
      resultsTable(rows),
      '',
      '## Distinct finding signatures',
      '',
      signatures.length === 0
        ? 'None. Every state the sweep tested recovered within the contract in `docs/model.md`.'
        : signatures.map((signature) => `- \`${signature}\``).join('\n'),
      '',
    ].join('\n'),
  )

  console.log(`\n${totalStates} states, ${totalFindings} findings, ${elapsedSeconds.toFixed(0)}s`)
  console.log(`wrote docs/results.md and plots/data/campaign.csv`)
  return 0
}

if (import.meta.main) {
  process.exit(main(process.argv))
}
