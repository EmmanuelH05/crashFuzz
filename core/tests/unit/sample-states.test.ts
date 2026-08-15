/**
 * Sampling enumerated states down to what can actually be materialized.
 *
 * Enumerating a state costs a few microseconds; materializing one costs a
 * filesystem creation, a loop device, two mounts and a recovery, which is
 * roughly five orders of magnitude more. A crash point that enumerates 14000
 * states cannot have all of them tested, so the campaign samples.
 *
 * The two extremes are always kept: the state where nothing unpinned persisted
 * and the state where everything did. Those are the boundaries of the space and
 * the cheapest places for a durability bug to show up, so leaving them to
 * chance would be a poor use of a sample.
 */

import { describe, expect, test } from 'bun:test'
import { sampleStates } from '../../src/enumerate/sample'
import type { CrashState } from '../../src/enumerate/states'

/** Twelve states at one crash point, persisting 0 through 11 operations. */
const STATES: CrashState[] = Array.from({ length: 12 }, (_, i) => ({
  crashPoint: 4,
  persisted: Array.from({ length: i }, (_, k) => k),
  partial: [],
}))

describe('sampleStates', () => {
  test('caps each crash point, keeps both extremes, and repeats for a seed', () => {
    const sample = (seed: number) => sampleStates(STATES, { maxPerCrashPoint: 5, seed })

    const first = sample(3)

    expect(first).toHaveLength(5)
    expect(first[0]).toEqual(STATES[0]!)
    expect(first.at(-1)).toEqual(STATES.at(-1)!)

    expect(sample(3)).toEqual(first)
    expect(sample(4)).not.toEqual(first)
  })
})
