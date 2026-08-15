/**
 * The Phase 4 results table.
 *
 * CLAUDE.md requires a results table by filesystem, mount option and workload
 * shape. A row that reports findings without reporting how many states produced
 * them is unreadable: zero findings over four states means nothing, and zero
 * over four thousand means something.
 */

import { describe, expect, test } from 'bun:test'
import { resultsTable } from '../../src/campaign/results'

describe('resultsTable', () => {
  test('reports states and findings per filesystem, mount option and shape', () => {
    const markdown = resultsTable([
      {
        configName: 'ext4-ordered',
        filesystem: 'ext4',
        mountOptions: 'data=ordered',
        shape: 'single',
        crashPointsTested: 12,
        statesTested: 288,
        findings: [],
      },
      {
        configName: 'xfs',
        filesystem: 'xfs',
        mountOptions: undefined,
        shape: 'large',
        crashPointsTested: 9,
        statesTested: 216,
        findings: [{ signature: 'LOST_ACKED|missing:pwrite@main.redb', count: 4 }],
      },
    ])

    // The mount option is a column, not a footnote: it is half of what a row
    // means on ext4.
    expect(markdown).toContain('| ext4 | data=ordered | single | 12 | 288 | 0 |')
    expect(markdown).toContain('| xfs | (default) | large | 9 | 216 | 1 |')

    // A totals line, so the 10,000 state gate can be read off the table rather
    // than recomputed by hand.
    expect(markdown).toContain('504')
  })
})
