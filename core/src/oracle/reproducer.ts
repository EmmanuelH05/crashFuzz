/**
 * Reproducer artifacts.
 *
 * CLAUDE.md: "Never claim a bug without a reproducer that runs on a machine you
 * have not touched." A finding is packaged as the image, the trace prefix that
 * produced it, the query, the expected result and the observed one, plus a
 * script that runs the whole thing against the image alone.
 *
 * The script deliberately does not re-enumerate or re-materialize anything. A
 * maintainer reading it should be able to see that it mounts a filesystem image
 * and asks their own binary a question, with nothing of ours in between.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Filesystem } from '../image/image'
import type { CrashState } from '../enumerate/states'
import type { Violation } from './oracle'

export type PackagedFinding = {
  signature: string
  occurrences: number
  state: CrashState
  imagePath: string
  violation: Violation
}

export type ReproducerOptions = {
  /** Directory the artifact is written to. Created if absent. */
  outDir: string
  /** Trace the finding came from. Truncated to the crash point in the artifact. */
  tracePath: string
  /** Database file name inside the image. */
  dbName: string
  filesystem: Filesystem
  /**
   * The query tool for the target this finding came from, as a shell command
   * taking the database path. An artifact that asks a different target reports
   * a confident and false observation rather than failing visibly, so this is
   * required rather than defaulted. Substituted unquoted into a bash array
   * literal so a multi-word command (a binary plus flags) splits into separate
   * arguments as intended; a path containing a space would split incorrectly
   * instead, so this and dbName must not contain one.
   */
  queryCommand: string
  /**
   * Shell command that builds the query tool, run only when the path in
   * queryCommand does not already exist. Written to use $repo, which the
   * script resolves from CRASHFUZZ_REPO or its own location. Without this the
   * artifact only runs on the machine that packaged it, which fails the
   * "reproduces from a fresh clone" gate.
   */
  buildCommand?: string
}

/**
 * Records up to and including the crash point. Everything after it is not part
 * of what the reproducer claims happened, and including it would invite the
 * reader to explain the finding with operations that had not run yet.
 */
function tracePrefix(tracePath: string, crashPoint: number): string {
  const lines = readFileSync(tracePath, 'utf8').split('\n').filter((line) => line.trim() !== '')

  const kept: string[] = []
  let events = 0

  for (const line of lines) {
    const record = JSON.parse(line) as { rec: string }
    if (record.rec === 'event') {
      if (events > crashPoint) continue
      events++
    }
    kept.push(line)
  }

  return `${kept.join('\n')}\n`
}

/** Escapes backslash, double quote and backtick for substitution into a double-quoted bash string. `$` is left alone so parameter expansion like `$repo` still works. */
function escapeForDoubleQuotedShell(value: string): string {
  return value.replace(/[\\"`]/g, '\\$&')
}

const RUN_SCRIPT = `#!/usr/bin/env bash
# Replays one crash image through the target's own recovery.
#
# Needs Linux, root for the loop device, and the environment this project's
# Requirements section documents: a Rust toolchain and /var/lib/crashfuzz
# writable (vm/lima.yaml provisions both). Builds the query tool itself if
# it is not already there:
#
#   CRASHFUZZ_REPO=/path/to/crashfuzz bash run.sh
#
# Nothing in this script enumerates or materializes anything. It mounts the
# image that shipped with the finding and asks the target what it can read.
set -euo pipefail

here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
repo="\${CRASHFUZZ_REPO:-$here/../../..}"

# The query tool for the target this finding came from. Substituted when the
# artifact was written, because asking a different target reports a confident
# and false observation rather than failing visibly.
query=(__QUERY_COMMAND__)
build="__BUILD_COMMAND__"

# A fresh clone has no build of the query tool at the path above. Build it
# rather than fail: the "reproduces on a machine you have not touched" gate
# means this artifact, not an already-built binary, is what has to be enough.
if [[ -n "$build" ]] && [[ ! -x "\${query[0]}" ]]; then
  echo "query tool not found at \${query[0]}, building it: $build" >&2
  eval "$build"
fi

mnt="$(mktemp -d)"
loop="$(sudo losetup --find --show "$here/state.img")"
cleanup() {
  sudo umount "$mnt" 2>/dev/null || true
  sudo losetup --detach "$loop" 2>/dev/null || true
  rmdir "$mnt" 2>/dev/null || true
}
trap cleanup EXIT

sudo mount "$loop" "$mnt"
sudo chmod 0777 "$mnt"

echo "--- expected ---"
sed -n 's/^  //p' "$here/finding.json" | grep -E '"(key|expected|actual|violationClass)"'
echo "--- observed now ---"
"\${query[@]}" "$mnt/__DB_NAME__"
`

const README = `# Crash-consistency finding

Generated by crashfuzz. Everything needed to see the behavior is in this
directory; nothing here re-runs the enumeration.

| File | What it is |
|---|---|
| \`state.img\` | The crash image, a real __FILESYSTEM__ filesystem. Mount it and look. |
| \`trace-prefix.jsonl\` | The target's own syscalls up to the crash point, and nothing after. |
| \`finding.json\` | The violation class, the key, what was expected and what came back. |
| \`run.sh\` | Mounts the image and asks the target what it can read. |

## Running it

\`\`\`bash
CRASHFUZZ_REPO=/path/to/crashfuzz bash run.sh
\`\`\`

Requires Linux, a loop device, sudo for the mount, and the environment this
project's Requirements section documents (a Rust toolchain, /var/lib/crashfuzz
writable — \`vm/lima.yaml\` provisions both). If the query tool this finding
was built against is not already there, the script builds it first.

## What the finding claims

__CLAIM__

The workload acknowledged this operation as durable before the crash point, at
the settings recorded in \`finding.json\`. The image is one of the states the
persistence model in \`docs/model.md\` says the filesystem could have been left
in by a crash at that point.
`

/** Writes a self-contained artifact for one finding and returns its directory. */
export function writeReproducer(finding: PackagedFinding, options: ReproducerOptions): string {
  mkdirSync(options.outDir, { recursive: true })

  copyFileSync(finding.imagePath, join(options.outDir, 'state.img'))
  writeFileSync(
    join(options.outDir, 'trace-prefix.jsonl'),
    tracePrefix(options.tracePath, finding.state.crashPoint),
  )

  writeFileSync(
    join(options.outDir, 'finding.json'),
    `${JSON.stringify(
      {
        signature: finding.signature,
        occurrences: finding.occurrences,
        filesystem: options.filesystem,
        database: options.dbName,
        violationClass: finding.violation.violationClass,
        key: finding.violation.key,
        expected: finding.violation.expected,
        actual: finding.violation.actual,
        crashStamp: finding.violation.crashStamp,
        state: finding.state,
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    join(options.outDir, 'run.sh'),
    RUN_SCRIPT.replace('__QUERY_COMMAND__', () => options.queryCommand)
      .replace('__BUILD_COMMAND__', () => escapeForDoubleQuotedShell(options.buildCommand ?? ''))
      .replace('__DB_NAME__', () => options.dbName),
  )

  const claim =
    finding.violation.violationClass === 'LOST_ACKED'
      ? `Key \`${finding.violation.key}\` should read back with digest \`${finding.violation.expected}\` and instead reads \`${finding.violation.actual}\`.`
      : `${finding.violation.violationClass}: ${finding.violation.actual}`

  writeFileSync(
    join(options.outDir, 'README.md'),
    README.replace('__FILESYSTEM__', options.filesystem).replace('__CLAIM__', claim),
  )

  return options.outDir
}
