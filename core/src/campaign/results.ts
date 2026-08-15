/**
 * The Phase 4 results table.
 *
 * A finding count means nothing without the state count beside it: zero
 * findings over four states and zero over four thousand are different claims,
 * and only one of them is worth reporting. The mount option is a column rather
 * than a footnote because on ext4 it is half of what the row means.
 */

export type SweepRow = {
  configName: string
  filesystem: string
  mountOptions: string | undefined
  shape: string
  crashPointsTested: number
  statesTested: number
  findings: { signature: string; count: number }[]
}

export function resultsTable(rows: SweepRow[]): string {
  const lines = [
    '| Filesystem | Mount | Shape | Crash points | States | Findings |',
    '|---|---|---|---|---|---|',
  ]

  for (const row of rows) {
    lines.push(
      `| ${row.filesystem} | ${row.mountOptions ?? '(default)'} | ${row.shape} | ` +
        `${row.crashPointsTested} | ${row.statesTested} | ${row.findings.length} |`,
    )
  }

  const states = rows.reduce((total, row) => total + row.statesTested, 0)
  const findings = rows.reduce((total, row) => total + row.findings.length, 0)

  lines.push(`| **total** | | | | **${states}** | **${findings}** |`)

  return lines.join('\n')
}
