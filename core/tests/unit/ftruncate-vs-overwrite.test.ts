/**
 * docs/findings.md cites this experiment as what settled the redb candidate:
 * on real ext4, can a data overwrite persist while an earlier ftruncate that
 * grew the same file does not? The mount/sleep/copy steps need a real loop
 * device and only run in the VM, but the verdict they feed into is a pure
 * decision over the observed (file length, header bytes) pair, and that is
 * what a wrong reading of "reordering happened" would actually get wrong.
 */

import { describe, expect, test } from 'bun:test'
import {
  classifyHeader,
  interpretObservation,
  writebackWaitIsSufficient,
} from '../../tools/ftruncate-vs-overwrite'

describe('writebackWaitIsSufficient', () => {
  test('is false when the wait does not comfortably exceed the kernel dirty_expire deadline', () => {
    // dirty_expire_centisecs and dirty_writeback_centisecs are both hundredths
    // of a second; 3000 is 30s, 500 is 5s.
    expect(writebackWaitIsSufficient(3000, 500, 45_000)).toBe(true)
    expect(writebackWaitIsSufficient(3000, 500, 20_000)).toBe(false)
  })

  test('requires the wait to also exceed one writeback wakeup past the expire deadline', () => {
    // The module's own reasoning is "the flusher settles the page within
    // dirty_expire_centisecs plus one writeback wakeup" - a wait that clears
    // dirty_expire_centisecs alone but not that extra wakeup is not the margin
    // the experiment actually needs.
    expect(writebackWaitIsSufficient(3000, 500, 35_000)).toBe(false)
    expect(writebackWaitIsSufficient(3000, 500, 35_001)).toBe(true)
  })
})

describe('classifyHeader', () => {
  test('classifies an empty buffer as ambiguous rather than vacuously old and new at once', () => {
    // Array.every on an empty array is vacuously true, so a naive "every byte
    // is 0x4e" / "every byte is 0x41" pair would both return true on a short
    // read - the one input this claim can least afford to be wrong about.
    expect(classifyHeader(Buffer.alloc(0), 320)).toBe('ambiguous')
  })
})

describe('interpretObservation', () => {
  test('reports the reordering demonstrated when the grow is missing but the header write survived', () => {
    const verdict = interpretObservation('ordered', { fileLen: 8388608, header: 'new' }, 8388608)

    expect(verdict.reorderingObserved).toBe(true)
  })

  test('reports no reordering when the grow and the header write persisted or fell together', () => {
    const grewTogether = interpretObservation('journal', { fileLen: 16777216, header: 'new' }, 8388608)
    const droppedTogether = interpretObservation('journal', { fileLen: 8388608, header: 'old' }, 8388608)

    expect(grewTogether.reorderingObserved).toBe(false)
    expect(droppedTogether.reorderingObserved).toBe(false)
  })

  test('treats a torn, inconclusive header as not demonstrating the reordering', () => {
    // Sector tearing could leave the header carrying neither pure old nor
    // pure new bytes. That is silence, not a positive result: a claim this
    // load-bearing rests only on an unambiguous header.
    const verdict = interpretObservation('ordered', { fileLen: 8388608, header: 'ambiguous' }, 8388608)

    expect(verdict.reorderingObserved).toBe(false)
  })

  test('confirms no-reordering only for the explicit old-bytes-at-old-length outcome, not merely the absence of the positive result', () => {
    // The journal arm is supposed to prove the mechanism, not just fail to
    // trigger it. A run that grew the file and lost the header write (the
    // opposite reordering), or one with an ambiguous header, is equally "not
    // reorderingObserved" but is not evidence the control held.
    const confirmed = interpretObservation('journal', { fileLen: 8388608, header: 'old' }, 8388608)
    const wrongDirection = interpretObservation('journal', { fileLen: 16777216, header: 'old' }, 8388608)
    const inconclusive = interpretObservation('journal', { fileLen: 8388608, header: 'ambiguous' }, 8388608)

    expect(confirmed.noReorderingConfirmed).toBe(true)
    expect(wrongDirection.noReorderingConfirmed).toBe(false)
    expect(inconclusive.noReorderingConfirmed).toBe(false)
  })
})
