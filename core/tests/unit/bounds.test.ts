/**
 * The bounds are configuration, not constants in the enumerator. CLAUDE.md
 * requires every bound to carry its justification beside its value, which is
 * why they live in a .jsonc file with comments and have to be parsed rather
 * than imported.
 */

import { describe, expect, test } from 'bun:test'
import { loadBounds } from '../../src/enumerate/bounds'

describe('loadBounds', () => {
  test('reads the values and their comments out of bounds.jsonc', () => {
    const bounds = loadBounds()

    expect(bounds.tornWrites).toBe(true)
    expect(bounds.tornWriteGranularityBytes).toBe(512)
    expect(bounds.maxTornOpsPerState).toBe(1)
    expect(bounds.maxUnpersistedWindow).toBe(8)
    expect(bounds.nonFsyncSampleRate).toBe(0.05)
    expect(bounds.maxExhaustiveWorkloadOps).toBe(3)
  })
})
