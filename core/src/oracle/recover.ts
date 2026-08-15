/**
 * Recovery for the SQLite control target.
 *
 * Pointing SQLite at a database file is its own recovery path, so this runs the
 * target's recovery rather than reimplementing it. The query tool reports
 * SQLite's own integrity check and the digest of every value it can read; both
 * judgements belong to the target, not to this project.
 */

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
 * Opens a database and reads back what survived. A database that will not open
 * comes back as `failed` rather than throwing: a bounded run materializes
 * thousands of images and some of them are expected not to open.
 */
export function recoverSqlite(dbPath: string): RecoveryResult {
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
