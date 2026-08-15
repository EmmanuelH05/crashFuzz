#!/usr/bin/env bun
/**
 * Runs the test suite and writes the result where tdd-guard reads it.
 *
 * tdd-guard ships reporters for vitest, jest, pytest and others, but not for
 * `bun test`, and this project's tests must run inside the Linux VM where the
 * guard's host-side hook cannot observe them. This script bridges both gaps: it
 * runs `bun test` in the VM (or directly, when already on Linux), converts the
 * JUnit output into the shape tdd-guard's reporters produce, and writes it to
 * .claude/tdd-guard/data/test.json.
 *
 *   bun run core/tools/tdd-report.ts [bun-test-args...]
 *
 * Bun's JUnit reporter emits empty <failure> elements, so the run's console
 * output is attached to the first failure of each module to preserve the
 * failure reason.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const VM_NAME = 'crashfuzz'
const JUNIT_PATH = '/tmp/crashfuzz-junit.xml'
const OUT_PATH = join(REPO_ROOT, '.claude', 'tdd-guard', 'data', 'test.json')

type TestState = 'passed' | 'failed' | 'skipped'

type FormattedTest = {
  name: string
  fullName: string
  state: TestState
  errors?: { message: string; stack?: string }[]
}

type ModuleResult = {
  moduleId: string
  tests: FormattedTest[]
}

type TestRunOutput = {
  testModules: ModuleResult[]
  unhandledErrors: unknown[]
  reason: 'passed' | 'failed'
}

/**
 * Runs bun test where the filesystem semantics under test exist. On macOS that
 * is the Lima VM; on Linux it is the current machine.
 */
function runTests(args: string[]): { output: string; junit: string; exitCode: number } {
  const bunArgs = ['test', ...args, '--reporter=junit', `--reporter-outfile=${JUNIT_PATH}`]

  // bun writes no JUnit file when a test module fails to load, so the previous
  // run's file is removed first and its absence is treated as a failure rather
  // than reported as the current result.
  const remote = `rm -f ${JUNIT_PATH}; cd ${REPO_ROOT} && bun ${bunArgs.join(' ')}`

  const proc =
    process.platform === 'linux'
      ? Bun.spawnSync(['bash', '-lc', remote])
      : Bun.spawnSync(['limactl', 'shell', VM_NAME, '--', 'bash', '-lc', remote])

  const read = `cat ${JUNIT_PATH} 2>/dev/null || true`
  const junit =
    process.platform === 'linux'
      ? Bun.spawnSync(['bash', '-lc', read])
      : Bun.spawnSync(['limactl', 'shell', VM_NAME, '--', 'bash', '-lc', read])

  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    junit: junit.stdout.toString(),
    exitCode: proc.exitCode ?? 1,
  }
}

/** Result used when the run produced no JUnit file, which means it did not start. */
function loadFailure(output: string): TestRunOutput {
  return {
    testModules: [
      {
        moduleId: 'test run',
        tests: [
          {
            name: 'test run did not produce results',
            fullName: 'test run did not produce results',
            state: 'failed',
            errors: [{ message: output.trim() || 'no output' }],
          },
        ],
      },
    ],
    unhandledErrors: [],
    reason: 'failed',
  }
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`))
  return match ? decodeXml(match[1]!) : ''
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Converts bun's JUnit XML into tdd-guard's TestRunOutput. Bun emits one
 * <testsuite> per test file and one <testcase> per test, with <failure> or
 * <skipped> children marking non-passing cases.
 */
function parseJunit(xml: string, consoleOutput: string): TestRunOutput {
  const testModules: ModuleResult[] = []

  const suites = xml.matchAll(/<testsuite\s([^>]*)>([\s\S]*?)<\/testsuite>/g)
  for (const suite of suites) {
    const suiteAttrs = suite[1]!
    const body = suite[2]!
    const file = attr(suiteAttrs, 'file') || attr(suiteAttrs, 'name')
    const tests: FormattedTest[] = []

    const cases = body.matchAll(/<testcase\s([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)
    for (const testcase of cases) {
      const caseAttrs = testcase[1]!
      const caseBody = testcase[3] ?? ''
      const name = attr(caseAttrs, 'name')
      const classname = attr(caseAttrs, 'classname')

      const failed = caseBody.includes('<failure')
      const skipped = caseBody.includes('<skipped')
      const state: TestState = failed ? 'failed' : skipped ? 'skipped' : 'passed'

      const test: FormattedTest = {
        name,
        fullName: classname ? `${classname} > ${name}` : name,
        state,
      }

      if (failed) {
        // Bun's JUnit failure elements carry no message, so the run's console
        // output stands in as the failure reason.
        test.errors = [{ message: consoleOutput.trim() || 'test failed' }]
      }

      tests.push(test)
    }

    testModules.push({ moduleId: join(REPO_ROOT, file), tests })
  }

  const anyFailed = testModules.some((m) => m.tests.some((t) => t.state === 'failed'))
  return { testModules, unhandledErrors: [], reason: anyFailed ? 'failed' : 'passed' }
}

function main(argv: string[]): number {
  const args = argv.slice(2)
  const { output, junit, exitCode } = runTests(args)

  console.log(output)

  const result = junit.trim() === '' ? loadFailure(output) : parseJunit(junit, output)

  // A module that fails to load contributes no test cases, so a run can exit
  // non-zero with nothing marked failed. That is recorded as a failure rather
  // than reported as a pass.
  const hasFailure = result.testModules.some((m) => m.tests.some((t) => t.state === 'failed'))
  if (exitCode !== 0 && !hasFailure) {
    result.testModules.push(loadFailure(output).testModules[0]!)
    result.reason = 'failed'
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2))

  const failures = result.testModules.flatMap((m) => m.tests.filter((t) => t.state === 'failed'))
  console.log(
    `tdd-report: ${result.testModules.length} module(s), ${failures.length} failing -> ${OUT_PATH}`,
  )
  return result.reason === 'failed' ? 1 : 0
}

process.exit(main(process.argv))
