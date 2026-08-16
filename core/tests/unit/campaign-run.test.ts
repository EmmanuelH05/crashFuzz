/**
 * The redb reproducer needs a build command wired to a real, working path, or
 * an artifact packaged by the campaign runs the fresh-clone gate can't pass.
 * Running the actual campaign to check this is a 21-minute integration test;
 * this checks the pure wiring instead.
 */

import { describe, expect, test } from 'bun:test'
import { redbQueryAndBuildCommand } from '../../tools/campaign-run'

describe('redbQueryAndBuildCommand', () => {
  test('points the build command at the redb-workload crate through $repo, not a baked-in path', () => {
    const { queryCommand, buildCommand } = redbQueryAndBuildCommand()

    expect(queryCommand.endsWith('/release/redb-query')).toBe(true)
    expect(buildCommand).toContain('$repo/targets/redb-workload/Cargo.toml')
  })
})
