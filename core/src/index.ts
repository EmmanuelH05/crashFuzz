#!/usr/bin/env bun
/**
 * crashfuzz command-line entrypoint.
 *
 * Subcommands are implemented per phase; see docs/EXECUTION-PLAN.md.
 */

const COMMANDS = {
  trace: 'Capture a syscall trace from a target workload (Phase 1)',
  enumerate: 'Enumerate legal crash states from a trace (Phase 2)',
  replay: 'Replay crash states through recovery and check the oracle (Phase 3)',
  campaign: 'Sweep filesystems and workload shapes (Phase 4)',
  doctor: 'Report whether the current environment can host a run',
} as const

type Command = keyof typeof COMMANDS

type Check = {
  name: string
  ok: boolean
  hint: string
}

/**
 * Environment preconditions. Extended in Phase 1 to cover /dev/loop
 * availability, filesystem support in /proc/filesystems, mkfs and losetup on
 * PATH, and write access to /var/lib/crashfuzz.
 */
function runChecks(): Check[] {
  return [
    {
      name: 'platform is linux',
      ok: process.platform === 'linux',
      hint: `found ${process.platform}; start the VM with 'bun run vm:sh'`,
    },
  ]
}

function doctor(): number {
  const checks = runChecks()
  const failed = checks.filter((c) => !c.ok)

  for (const check of checks) {
    const status = check.ok ? 'ok' : 'FAIL'
    const detail = check.ok ? '' : `  (${check.hint})`
    console.log(`${status.padEnd(5)}${check.name}${detail}`)
  }

  console.log(failed.length === 0 ? '\nEnvironment OK.' : `\n${failed.length} check(s) failed.`)
  return failed.length === 0 ? 0 : 1
}

function usage(): void {
  console.log('crashfuzz - application-level crash-consistency checker\n')
  console.log('Usage: bun run cf <command>\n')
  for (const [name, description] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(11)}${description}`)
  }
  console.log('\nSee docs/EXECUTION-PLAN.md for the current phase status.')
}

function main(argv: string[]): number {
  const command = argv[2]

  if (!command) {
    usage()
    return 0
  }

  if (!(command in COMMANDS)) {
    console.error(`Unknown command: ${command}\n`)
    usage()
    return 2
  }

  if (command === 'doctor') {
    return doctor()
  }

  console.error(`Not implemented: ${command} (${COMMANDS[command as Command]})`)
  return 3
}

process.exit(main(process.argv))
