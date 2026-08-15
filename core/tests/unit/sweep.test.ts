/**
 * The Phase 4 sweep matrix.
 *
 * Every configuration pairs a persistence model from docs/model.md with the
 * filesystem and mount options that model describes. Getting that pairing wrong
 * is the quietest way to produce a false positive: states enumerated under
 * ext4 `data=journal`, which persists everything in program order, would be
 * legal states under a model the mounted filesystem does not implement, and
 * every reordering the enumerator allowed would look like a target bug.
 */

import { describe, expect, test } from 'bun:test'
import { SHAPES, SWEEP, sweepPlan } from '../../src/campaign/sweep'

describe('SWEEP', () => {
  test('pairs each model with the filesystem and mount options it describes', () => {
    const byName = new Map(SWEEP.map((config) => [config.name, config]))

    expect([...byName.keys()].sort()).toEqual([
      'btrfs',
      'ext4-journal',
      'ext4-ordered',
      'xfs',
    ])

    // The two ext4 rows differ only in the journal mode, and each mounts the
    // way its model says the filesystem behaves.
    expect(byName.get('ext4-ordered')!.filesystem).toBe('ext4')
    expect(byName.get('ext4-ordered')!.mountOptions).toBe('data=ordered')
    expect(byName.get('ext4-journal')!.filesystem).toBe('ext4')
    expect(byName.get('ext4-journal')!.mountOptions).toBe('data=journal')

    // data=journal is the mode that persists in program order, and it is the
    // only one in the sweep whose model says so.
    expect(byName.get('ext4-journal')!.model.totalOrder).toBe(true)
    expect(SWEEP.filter((config) => config.model.totalOrder)).toHaveLength(1)

    // Every configuration names the model it was enumerated under, so a result
    // row cannot be read against the wrong one.
    for (const config of SWEEP) {
      expect(config.model.name).toBe(config.name)
    }
  })

  test('the run plan covers every filesystem and every shape', () => {
    // The Phase 4 gate is a sweep, so a plan that quietly dropped a filesystem
    // or a shape would still produce a full-looking results table. The plan is
    // built once and asserted here rather than being implied by a nested loop
    // in the driver.
    const plan = sweepPlan()

    expect(plan).toHaveLength(SWEEP.length * SHAPES.length)

    for (const config of SWEEP) {
      for (const shape of SHAPES) {
        expect(plan.some((run) => run.config.name === config.name && run.shape === shape)).toBe(
          true,
        )
      }
    }
  })
})
