/**
 * Building and locating the target workloads.
 *
 * redb is built into /var/lib/crashfuzz/cargo-target rather than into the repo,
 * because the repo is a virtiofs mount and cargo on it is slow enough to
 * dominate a campaign run.
 */

import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const CARGO_TARGET_DIR = '/var/lib/crashfuzz/cargo-target'

/** Path to a binary from the redb workload crate. */
export function redbBinary(name: string): string {
  return join(CARGO_TARGET_DIR, 'release', name)
}

/** Builds the redb workload and query binaries. Cheap once cargo has cached. */
export function buildRedbWorkload(): void {
  const build = Bun.spawnSync(
    ['cargo', 'build', '--release', '--manifest-path', join(REPO_ROOT, 'targets', 'redb-workload', 'Cargo.toml')],
    { env: { ...process.env, CARGO_TARGET_DIR } },
  )

  if (build.exitCode !== 0) {
    throw new Error(`building redb-workload failed: ${build.stderr.toString()}`)
  }
}
