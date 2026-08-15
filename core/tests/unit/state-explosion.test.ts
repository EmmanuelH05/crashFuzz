/**
 * The Phase 2 exit criterion says the state count must be roughly polynomial in
 * trace length under the bounds. "Roughly polynomial" is reported as the
 * exponent p in states ~ operations^p, which is the slope of the count against
 * the length on log-log axes.
 *
 * This checks the slope estimator against data whose exponent is known, so a
 * claim made about the real curve rests on a measurement that was itself
 * measured.
 */

import { describe, expect, test } from 'bun:test'
import { formatOutputs, logLogSlope } from '../../tools/state-explosion'

describe('logLogSlope', () => {
  test('recovers the exponent of an exact power law', () => {
    const quadratic = [2, 4, 8, 16, 32, 64].map((operations) => ({
      operations,
      regime: 'bounded' as const,
      crashPoints: operations,
      states: operations ** 2,
    }))

    expect(logLogSlope(quadratic)).toBeCloseTo(2, 6)
  })
})

describe('formatOutputs', () => {
  test('emits the measurements as csv and the fitted exponents beside them', () => {
    // The plotting script draws the exponent it is given rather than fitting
    // its own, so the number on the figure comes from the estimator above
    // instead of a second implementation of it in Python.
    const rows = [2, 4, 8, 16].map((operations) => ({
      operations,
      regime: 'bounded' as const,
      crashPoints: operations,
      states: operations ** 2,
    }))

    const { csv, fit } = formatOutputs(rows)

    expect(csv.split('\n')[0]).toBe('operations,regime,crash_points,states')
    expect(csv.split('\n')[1]).toBe('2,bounded,2,4')
    expect(JSON.parse(fit).boundedExponent).toBeCloseTo(2, 6)
  })
})
