/**
 * Replaying a trace reconstructs the file state the target produced, without
 * the target being present. Phase 2 materializes crash states the same way,
 * from a prefix of the trace rather than all of it.
 *
 * Linux only. Run with: bun run test:vm core/tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTrace } from '../../src/trace/reader'
import { replayTrace } from '../../src/trace/replay'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')

let workdir: string

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crashfuzz-replay-'))

  const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, 'shim')])
  if (make.exitCode !== 0) {
    throw new Error(`building shim.so failed: ${make.stderr.toString()}`)
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('replayTrace', () => {
  test('reproduces the files a traced workload left behind', async () => {
    const src = join(workdir, 'protocol.c')
    const bin = join(workdir, 'protocol')
    writeFileSync(
      src,
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        char tmp[512], final[512];
        snprintf(tmp, sizeof tmp, "%s/f.tmp", argv[1]);
        snprintf(final, sizeof final, "%s/f", argv[1]);

        int fd = open(tmp, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (write(fd, "header--", 8) != 8) return 2;
        if (write(fd, "body", 4) != 4) return 3;
        if (pwrite(fd, "HEAD", 4, 0) != 4) return 4;
        if (fsync(fd) != 0) return 5;
        if (close(fd) != 0) return 6;
        return rename(tmp, final);
      }
      `,
    )
    const cc = Bun.spawnSync(['cc', '-O0', '-o', bin, src])
    if (cc.exitCode !== 0) throw new Error(cc.stderr.toString())

    const liveDir = mkdtempSync(join(workdir, 'live-'))
    const traceDir = mkdtempSync(join(workdir, 'trace-'))
    const run = Bun.spawnSync([bin, liveDir], {
      env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir },
    })
    if (run.exitCode !== 0) throw new Error(`workload exited ${run.exitCode}`)

    const trace = parseTrace(await Bun.file(join(traceDir, `trace-${run.pid}.jsonl`)).text())
    const replayDir = mkdtempSync(join(workdir, 'replay-'))
    replayTrace(trace, { casDir: join(traceDir, 'cas'), rootDir: liveDir, targetDir: replayDir })

    expect(readFileSync(join(replayDir, 'f'))).toEqual(readFileSync(join(liveDir, 'f')))
    expect(readFileSync(join(replayDir, 'f')).toString()).toBe('HEADer--body')
  })
})
