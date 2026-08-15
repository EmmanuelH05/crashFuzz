/**
 * The command-line entrypoint.
 *
 * `cf enumerate` is how a trace gets inspected without running a campaign
 * against it: it reports how many crash points the bounds select and how many
 * states they produce, which is the number that decides whether a sweep is
 * worth starting. It materializes nothing, so it is safe to run anywhere.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const CLI = join(REPO_ROOT, 'core', 'src', 'index.ts')

/** Three writes and an fsync, as trace format v1 on disk. */
function writeTrace(dir: string): string {
  const records = [
    { rec: 'header', v: 1, pid: 1 },
    ...[0, 1, 2].map((i) => ({
      rec: 'event',
      i,
      j: i + 100,
      call: 'pwrite',
      fd: 3,
      tid: 1,
      path: '/db/main',
      path2: '',
      off: i * 4096,
      len: 4096,
      ret: 4096,
      err: 0,
      dig: 'a'.repeat(64),
    })),
    {
      rec: 'event',
      i: 3,
      j: 103,
      call: 'fsync',
      fd: 3,
      tid: 1,
      path: '/db/main',
      path2: '',
      off: 0,
      len: 0,
      ret: 0,
      err: 0,
      dig: '',
    },
  ]

  const path = join(dir, 'trace.jsonl')
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

describe('cf enumerate', () => {
  test('reports crash points and state counts for a trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crashfuzz-cli-'))

    try {
      const tracePath = writeTrace(dir)
      const proc = Bun.spawnSync(['bun', 'run', CLI, 'enumerate', tracePath])
      const output = proc.stdout.toString()

      expect(proc.exitCode).toBe(0)
      expect(output).toContain('ext4-ordered')
      expect(output).toContain('crash points')

      // One row per model, each carrying three counts. The fsync pins all three
      // writes, so every model reports exactly one state: nothing is free to be
      // absent, which is what a durability floor means.
      expect(output).toMatch(/ext4-ordered\s+1\s+1\s+1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
