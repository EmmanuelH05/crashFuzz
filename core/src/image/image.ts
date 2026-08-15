/**
 * Crash images: real filesystems on loopback devices.
 *
 * A crash state has to be materialized on the filesystem whose reordering
 * behavior the state was enumerated under, because that filesystem is what the
 * target's recovery will run against. A directory tree would test nothing.
 *
 * Images are sparse files on the guest disk under /var/lib/crashfuzz. Every
 * operation here shells out to privileged tooling, which the VM allows without
 * a password; nothing in this module touches the host.
 */

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CrashState } from '../enumerate/states'
import { replaySelection } from '../trace/replay'
import type { Trace } from '../trace/reader'

export type Filesystem = 'ext4' | 'xfs' | 'btrfs'

export type ImageSpec = {
  /** Sparse file the filesystem is made in. */
  imagePath: string
  filesystem: Filesystem
  /**
   * Size of the sparse file. xfsprogs refuses anything under 300 MiB and btrfs
   * under about 109 MiB, so callers should stay above both.
   */
  sizeBytes: number
}

/** Where mount points are made. On the guest disk, never on the repo mount. */
const MOUNT_ROOT = '/var/lib/crashfuzz/mnt'

function run(command: string[]): void {
  const proc = Bun.spawnSync(command)
  if (proc.exitCode !== 0) {
    const detail = (proc.stderr.toString() + proc.stdout.toString()).trim()
    throw new Error(`${command.join(' ')} failed (${proc.exitCode}): ${detail}`)
  }
}

function capture(command: string[]): string {
  const proc = Bun.spawnSync(command)
  if (proc.exitCode !== 0) {
    const detail = (proc.stderr.toString() + proc.stdout.toString()).trim()
    throw new Error(`${command.join(' ')} failed (${proc.exitCode}): ${detail}`)
  }
  return proc.stdout.toString().trim()
}

/** Options that keep a fresh filesystem byte-identical from run to run. */
function formatCommand(spec: ImageSpec): string[] {
  switch (spec.filesystem) {
    case 'ext4':
      // -F formats a file rather than a block device; -q keeps the run quiet.
      return ['/usr/sbin/mkfs.ext4', '-q', '-F', spec.imagePath]
    case 'xfs':
      return ['/usr/sbin/mkfs.xfs', '-q', '-f', spec.imagePath]
    case 'btrfs':
      return ['/usr/sbin/mkfs.btrfs', '-q', '-f', spec.imagePath]
  }
}

/** Creates a sparse file and makes a fresh filesystem in it. */
export function createImage(spec: ImageSpec): void {
  mkdirSync(dirname(spec.imagePath), { recursive: true })
  writeFileSync(spec.imagePath, '')
  truncateSync(spec.imagePath, spec.sizeBytes)
  run(formatCommand(spec))
}

/**
 * Mounts an image, runs the callback against the mount point, and always
 * unmounts and detaches the loop device, including when the callback throws. A
 * leaked loop device outlives the test process and exhausts /dev/loop*.
 */
export function withMount<T>(imagePath: string, fn: (mountDir: string) => T): T {
  mkdirSync(MOUNT_ROOT, { recursive: true })
  const mountDir = mkdtempSync(`${MOUNT_ROOT}/m-`)
  const loopDevice = capture(['sudo', 'losetup', '--find', '--show', imagePath])

  try {
    run(['sudo', 'mount', loopDevice, mountDir])
    try {
      // The caller's process is not root, so it has to be able to write here.
      run(['sudo', 'chmod', '0777', mountDir])
      return fn(mountDir)
    } finally {
      run(['sudo', 'umount', mountDir])
    }
  } finally {
    run(['sudo', 'losetup', '--detach', loopDevice])
    rmSync(mountDir, { recursive: true, force: true })
  }
}

export type MaterializeOptions = ImageSpec & {
  /** Payload store written during capture. */
  casDir: string
  /** Directory the traced paths are relative to. */
  rootDir: string
}

/**
 * Materializes one crash state as an image the target can be pointed at: a
 * fresh filesystem carrying exactly the operations the state says persisted.
 *
 * The image is left unmounted, so it can be handed to recovery as many times as
 * Phase 3 needs without the enumeration being rerun.
 */
export function materializeState(
  trace: Trace,
  state: CrashState,
  options: MaterializeOptions,
): void {
  createImage(options)

  withMount(options.imagePath, (mountDir) => {
    replaySelection(trace, { casDir: options.casDir, rootDir: options.rootDir, targetDir: mountDir }, state)
  })
}
