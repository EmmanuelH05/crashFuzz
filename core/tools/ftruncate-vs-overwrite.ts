#!/usr/bin/env bun
/**
 * The experiment docs/findings.md names as what would settle the redb
 * candidate: on a real ext4, can a data overwrite reach the disk while an
 * earlier ftruncate that grew the same file does not, with no persistence
 * call between them?
 *
 * Method. A dedicated ext4 on a loop device is mounted with commit=300, so
 * the journal - which carries the size change - does not commit for five
 * minutes. The dirty data page is left to the background flusher, which
 * writes it back within ~35s (vm.dirty_expire_centisecs=3000 on the project
 * VM). Copying the backing file after that wait, while the filesystem is
 * still mounted, approximates what the block device holds at that point -
 * close enough to a power-cut snapshot for the writeback deadline it is
 * timed against, not a guarantee against every possible write in flight.
 * Mounting the copy replays the journal the way a real post-crash mount
 * would.
 *
 * If the copy shows the new header at the old file length, the reordering
 * docs/model.md permits on ext4 data=ordered is one the filesystem actually
 * performs. The same run against data=journal is the negative control: there
 * the size change rides the journal alongside everything else, so the copy
 * must show neither the new header nor the new length.
 *
 * Runs only in the VM, only on loop devices under /var/lib/crashfuzz:
 *
 *   bun run core/tools/ftruncate-vs-overwrite.ts
 */

import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { withMount } from '../src/image/image'

const DIRTY_EXPIRE_PATH = '/proc/sys/vm/dirty_expire_centisecs'
const DIRTY_WRITEBACK_PATH = '/proc/sys/vm/dirty_writeback_centisecs'

const WORK_DIR = '/var/lib/crashfuzz/exp/ftruncate-vs-overwrite'
const IMAGE_BYTES = 64 * 1024 * 1024
const BASE_LEN = 8 * 1024 * 1024
const GROWN_LEN = 16 * 1024 * 1024
const HEADER_LEN = 320
/** Past vm.dirty_expire_centisecs (30s on the project VM) plus one flusher wakeup. */
const WRITEBACK_WAIT_MS = 45_000
const NEW_BYTE = 0x4e // 'N', written after the ftruncate under test
const OLD_BYTE = 0x41 // 'A', the durable base

type DataMode = 'ordered' | 'journal'

export type HeaderClassification = 'new' | 'old' | 'ambiguous'

/**
 * Whether a header read is unambiguously the post-overwrite bytes, the
 * pre-overwrite bytes, or neither. `Array.every` on a short or empty read is
 * vacuously true for any predicate, which would otherwise report a truncated
 * read as both "new" and "old" at once - silence has to come out as silence.
 */
export function classifyHeader(bytes: Uint8Array, expectedLen: number): HeaderClassification {
  if (bytes.length !== expectedLen) return 'ambiguous'
  if (bytes.every((byte) => byte === NEW_BYTE)) return 'new'
  if (bytes.every((byte) => byte === OLD_BYTE)) return 'old'
  return 'ambiguous'
}

export type Observation = {
  fileLen: number
  header: HeaderClassification
}

export type Verdict = {
  dataMode: DataMode
  /** The grow was dropped while the overwrite survived: the hypothesis under test. */
  reorderingObserved: boolean
  /** Both effects were dropped together: what the journal arm is supposed to show. */
  noReorderingConfirmed: boolean
}

/**
 * The pure judgment call. Three outcomes matter, and they are not each
 * other's negation: the grow dropped while the header survived (the
 * hypothesis), both survived or both dropped together (no reordering, and
 * confirmed as such only when explicitly old-at-old-length), or the header
 * was ambiguous, which proves nothing either way and must not be read as a
 * negative result by default.
 */
export function interpretObservation(
  dataMode: DataMode,
  observation: Observation,
  baseLen: number,
): Verdict {
  return {
    dataMode,
    reorderingObserved: observation.fileLen === baseLen && observation.header === 'new',
    noReorderingConfirmed: observation.fileLen === baseLen && observation.header === 'old',
  }
}

function run(command: string[]): void {
  const proc = Bun.spawnSync(command)
  if (proc.exitCode !== 0) {
    const detail = (proc.stderr.toString() + proc.stdout.toString()).trim()
    throw new Error(`${command.join(' ')} failed (${proc.exitCode}): ${detail}`)
  }
}

/** Mounts the snapshot - replaying the journal as a post-crash mount would - and reads the file back. */
function observeSnapshot(snapshotPath: string, mountOptions: string): Observation {
  return withMount(
    snapshotPath,
    (mountDir) => {
      const fileLen = statSync(`${mountDir}/testfile`).size
      const head = readFileSync(`${mountDir}/testfile`).subarray(0, HEADER_LEN)
      return { fileLen, header: classifyHeader(head, HEADER_LEN) }
    },
    { mountOptions },
  )
}

function runExperiment(dataMode: DataMode): Observation {
  const imagePath = `${WORK_DIR}/${dataMode}.img`
  const snapshotPath = `${WORK_DIR}/${dataMode}-crash.img`
  // The size change persists only through a journal commit, so commit=300
  // keeps it off the disk for the whole run while the flusher settles the
  // data page on its default ~30s schedule.
  const mountOptions = `data=${dataMode},commit=300,noatime`

  mkdirSync(WORK_DIR, { recursive: true })
  writeFileSync(imagePath, '')
  truncateSync(imagePath, IMAGE_BYTES)
  // lazy init disabled so no kernel thread writes to the image mid-experiment.
  run(['/usr/sbin/mkfs.ext4', '-q', '-F', '-E', 'lazy_itable_init=0,lazy_journal_init=0', imagePath])

  withMount(
    imagePath,
    (mountDir) => {
      const filePath = `${mountDir}/testfile`

      // Durable base, fsynced, then a global sync so the journal is quiet
      // before the sequence under test begins.
      const baseFd = openSync(filePath, 'w')
      writeSync(baseFd, Buffer.alloc(BASE_LEN, OLD_BYTE))
      fsyncSync(baseFd)
      closeSync(baseFd)
      run(['sudo', 'sync'])

      // The sequence under test: grow, overwrite the header, no persistence
      // call. This is redb's grow protocol with the commit fsync never reached.
      const fd = openSync(filePath, 'r+')
      ftruncateSync(fd, GROWN_LEN)
      writeSync(fd, Buffer.alloc(HEADER_LEN, NEW_BYTE), 0, HEADER_LEN, 0)
      closeSync(fd)

      console.log(`[${dataMode}] waiting ${WRITEBACK_WAIT_MS / 1000}s for background writeback`)
      Bun.sleepSync(WRITEBACK_WAIT_MS)

      // The crash: what the block device holds at this instant, taken while
      // the filesystem is still mounted so nothing is flushed by teardown.
      run(['cp', '--sparse=always', imagePath, snapshotPath])
      console.log(`[${dataMode}] live file length: ${statSync(filePath).size}`)
    },
    { mountOptions },
  )

  return observeSnapshot(snapshotPath, `data=${dataMode}`)
}

/**
 * dirtyExpireCentisecs and dirtyWritebackCentisecs are
 * /proc/sys/vm/dirty_{expire,writeback}_centisecs: hundredths of a second.
 * The flusher settles a dirty page within dirty_expire_centisecs of one of
 * its periodic wakeups, which happen every dirty_writeback_centisecs, so the
 * wait has to clear the deadline plus one more wakeup past it.
 */
export function writebackWaitIsSufficient(
  dirtyExpireCentisecs: number,
  dirtyWritebackCentisecs: number,
  waitMs: number,
): boolean {
  return waitMs > (dirtyExpireCentisecs + dirtyWritebackCentisecs) * 10
}

function checkWritebackAssumption(): void {
  const rawExpire = readFileSync(DIRTY_EXPIRE_PATH, 'utf8').trim()
  const rawWriteback = readFileSync(DIRTY_WRITEBACK_PATH, 'utf8').trim()
  const dirtyExpireCentisecs = Number(rawExpire)
  const dirtyWritebackCentisecs = Number(rawWriteback)
  if (!Number.isFinite(dirtyExpireCentisecs)) {
    throw new Error(`could not parse ${DIRTY_EXPIRE_PATH}: got "${rawExpire}"`)
  }
  if (!Number.isFinite(dirtyWritebackCentisecs)) {
    throw new Error(`could not parse ${DIRTY_WRITEBACK_PATH}: got "${rawWriteback}"`)
  }
  console.log(
    `${DIRTY_EXPIRE_PATH}=${rawExpire}, ${DIRTY_WRITEBACK_PATH}=${rawWriteback}, ` +
      `waiting ${WRITEBACK_WAIT_MS}ms per arm`,
  )
  if (!writebackWaitIsSufficient(dirtyExpireCentisecs, dirtyWritebackCentisecs, WRITEBACK_WAIT_MS)) {
    throw new Error(
      `WRITEBACK_WAIT_MS (${WRITEBACK_WAIT_MS}) does not clear dirty_expire_centisecs ` +
        `(${rawExpire}) plus one dirty_writeback_centisecs wakeup (${rawWriteback}) on this machine`,
    )
  }
}

function main(): number {
  checkWritebackAssumption()

  const ordered = interpretObservation('ordered', runExperiment('ordered'), BASE_LEN)
  const journal = interpretObservation('journal', runExperiment('journal'), BASE_LEN)

  console.log(`ordered: reordering ${ordered.reorderingObserved ? 'DEMONSTRATED' : 'not observed'}`)
  console.log(
    `journal control: ${journal.noReorderingConfirmed ? 'held (confirmed old bytes, old length)' : 'INCONCLUSIVE - did not confirm old bytes at old length'}`,
  )

  // A failed or inconclusive control invalidates the positive result too: it
  // means the timing assumption this experiment rests on did not hold here,
  // not that the reordering is somehow real only on the ordered arm.
  return ordered.reorderingObserved && journal.noReorderingConfirmed ? 0 : 1
}

if (import.meta.main) {
  process.exit(main())
}
