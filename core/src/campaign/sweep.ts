/**
 * The Phase 4 sweep matrix.
 *
 * Each configuration pairs a persistence model from docs/model.md with the
 * filesystem and mount options that model describes. The pairing is the whole
 * point: states enumerated under ext4 `data=journal`, which persists everything
 * in program order, are a different set from the ones legal under
 * `data=ordered`, and mounting one while enumerating the other would make every
 * permitted reordering look like a target bug.
 */

import { btrfs, ext4Journal, ext4Ordered, xfs } from '../graph/models'
import type { FilesystemModel } from '../graph/models'
import type { Filesystem } from '../image/image'

export type SweepConfig = {
  /** Matches the model name, so a result row cannot be read against the wrong model. */
  name: string
  filesystem: Filesystem
  /** Passed to `mount -o`. Undefined means the filesystem's default. */
  mountOptions?: string
  model: FilesystemModel
}

/**
 * `data=ordered` is stated explicitly rather than left to the default, so the
 * results table records what was mounted instead of what the kernel happened to
 * pick.
 */
export const SWEEP: SweepConfig[] = [
  { name: 'ext4-ordered', filesystem: 'ext4', mountOptions: 'data=ordered', model: ext4Ordered },
  { name: 'ext4-journal', filesystem: 'ext4', mountOptions: 'data=journal', model: ext4Journal },
  { name: 'xfs', filesystem: 'xfs', model: xfs },
  { name: 'btrfs', filesystem: 'btrfs', model: btrfs },
]

/**
 * Workload shapes, matching the shape argument the redb workload accepts. The
 * rename-based update protocol is a separate target (`targets/unsafe-kv`)
 * because redb does not use one.
 */
export const SHAPES = ['single', 'large', 'many', 'mixed', 'concurrent'] as const

export type Shape = (typeof SHAPES)[number]

export type SweepRun = {
  config: SweepConfig
  shape: Shape
}

/**
 * Every filesystem against every shape. Built here rather than as a nested loop
 * inside the driver so that a plan which quietly dropped a combination is
 * caught by a test instead of producing a full-looking results table.
 */
export function sweepPlan(): SweepRun[] {
  return SWEEP.flatMap((config) => SHAPES.map((shape) => ({ config, shape })))
}
