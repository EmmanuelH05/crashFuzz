/**
 * Recovery for the SQLite control target.
 *
 * Pointing SQLite at a database file is its own recovery path, so this runs the
 * target's recovery rather than reimplementing it. The query tool reports
 * SQLite's own integrity check and the digest of every value it can read; both
 * judgements belong to the target, not to this project.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RecoveryResult } from './oracle'

const QUERY_TOOL = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'targets',
  'sqlite-workload',
  'build',
  'sqlite-query',
)

/**
 * Recovery for the unsafe key-value store, the positive control.
 *
 * That application has no recovery path and no integrity check: a value is
 * whatever file bears its name. Reading the directory is therefore the whole of
 * its recovery, and `integrityOk` is true because it has no invariant of its
 * own to fail. Every violation it produces is a LOST_ACKED, which is the point.
 */
export function recoverFileKv(mountDir: string): RecoveryResult {
  const values = new Map<string, string>()

  for (const entry of readdirSync(mountDir, { withFileTypes: true })) {
    // Temporary files are the protocol's scratch space, not values, and the
    // marker file is the harness's own channel.
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.tmp') || entry.name === 'crashfuzz.marker') continue

    const hash = createHash('sha256')
    hash.update(readFileSync(join(mountDir, entry.name)))
    values.set(entry.name, hash.digest('hex'))
  }

  return { status: 'opened', integrityOk: true, values }
}

/**
 * Opens a database and reads back what survived. A database that will not open
 * comes back as `failed` rather than throwing: a bounded run materializes
 * thousands of images and some of them are expected not to open.
 */
export function recoverSqlite(dbPath: string): RecoveryResult {
  // An image from before the database file was created is not a recovery
  // failure. The target cannot be blamed for refusing to open a file that the
  // crash point predates, and nothing is acknowledged that early for it to have
  // lost. It is reported as an empty database, which leaves the oracle free to
  // flag anything that was acknowledged and is now missing.
  if (!existsSync(dbPath)) {
    return {
      status: 'opened',
      integrityOk: true,
      values: new Map(),
      detail: 'database file absent at this crash point',
    }
  }

  const proc = Bun.spawnSync([QUERY_TOOL, dbPath])
  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString().trim()

  if (proc.exitCode !== 0) {
    return { status: 'failed', detail: stderr || `query exited ${proc.exitCode}` }
  }

  let integrityOk = false
  const values = new Map<string, string>()

  for (const line of stdout.split('\n')) {
    if (line === '') continue

    if (line.startsWith('integrity=')) {
      integrityOk = line.slice('integrity='.length) === 'ok'
      continue
    }

    const [key, digest] = line.split(' ')
    if (key !== undefined && digest !== undefined) values.set(key, digest)
  }

  return { status: 'opened', integrityOk, values, detail: stderr || undefined }
}
