/**
 * Crash images are real filesystems on loopback devices, not directory trees.
 * The filesystem is the thing whose semantics are under test, so a state has to
 * be materialized on one before the target can be pointed at it.
 *
 * Images live on the guest disk under /var/lib/crashfuzz, never on the virtiofs
 * mount the repo is shared through, which does not provide the semantics under
 * test. See CLAUDE.md, build invariants.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createImage, materializeState, withMount } from '../../src/image/image'
import type { Trace, TraceEvent } from '../../src/trace/reader'

const SCRATCH = '/var/lib/crashfuzz/images'

describe('createImage', () => {
  test('makes an ext4 filesystem that mounts and is empty', () => {
    const dir = mkdtempSync(join(SCRATCH, 'test-'))
    const imagePath = join(dir, 'ext4.img')

    try {
      createImage({ imagePath, filesystem: 'ext4', sizeBytes: 512 * 1024 * 1024 })

      const entries = withMount(imagePath, (mountDir) => readdirSync(mountDir).sort())

      expect(entries).toEqual(['lost+found'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Two writes to two files. The crash state has the first fully persisted and
 * the second on disk as a 512-byte prefix of its 1024-byte payload, which is
 * the torn-write shape docs/model.md permits.
 */
function event(index: number, fields: Partial<TraceEvent>): TraceEvent {
  return {
    index,
    completionIndex: index + 1000,
    call: 'write',
    fd: 3,
    threadId: 1,
    path: '/db/a',
    path2: '',
    offset: 0,
    length: 1024,
    returnValue: 1024,
    errno: 0,
    digest: '',
    ...fields,
  }
}

describe('materializeState', () => {
  test('writes the persisted subset, torn writes truncated to their prefix', () => {
    const dir = mkdtempSync(join(SCRATCH, 'test-'))
    const casDir = join(dir, 'cas')
    mkdirSync(casDir, { recursive: true })

    const payloadA = Buffer.alloc(1024, 0xaa)
    const payloadB = Buffer.alloc(1024, 0xbb)
    writeFileSync(join(casDir, 'digest-a'), payloadA)
    writeFileSync(join(casDir, 'digest-b'), payloadB)

    const trace: Trace = {
      header: { version: 1, pid: 1 },
      events: [
        event(0, { path: '/db/a', digest: 'digest-a' }),
        event(1, { path: '/db/b', digest: 'digest-b' }),
      ],
      markers: [],
    }

    const imagePath = join(dir, 'state.img')

    try {
      materializeState(
        trace,
        { crashPoint: 1, persisted: [0], partial: [{ op: 1, bytes: 512 }] },
        {
          imagePath,
          filesystem: 'ext4',
          sizeBytes: 512 * 1024 * 1024,
          casDir,
          rootDir: '/db',
        },
      )

      const contents = withMount(imagePath, (mountDir) => ({
        a: readFileSync(join(mountDir, 'a')),
        b: readFileSync(join(mountDir, 'b')),
      }))

      expect(contents.a).toEqual(payloadA)
      expect(contents.b).toEqual(payloadB.subarray(0, 512))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
