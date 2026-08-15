/**
 * Phase 0 criterion 6: a candidate target must route its file I/O through libc,
 * or the LD_PRELOAD capture in Phase 1 observes nothing. probe.so answers that
 * question; these tests establish that its answer is trustworthy.
 *
 * Linux only. Run with: bun run vm:sh -- bun test core/tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PROBE_SO = join(REPO_ROOT, 'shim', 'build', 'probe.so')

let workdir: string

/** Writes, compiles, and returns the path to a C workload binary. */
function buildWorkload(name: string, source: string): string {
  const src = join(workdir, `${name}.c`)
  const bin = join(workdir, name)
  writeFileSync(src, source)

  const cc = Bun.spawnSync(['cc', '-O0', '-o', bin, src])
  if (cc.exitCode !== 0) {
    throw new Error(`compiling ${name} failed: ${cc.stderr.toString()}`)
  }
  return bin
}

/** Runs a binary under probe.so and returns the path of the probe's report. */
function runUnderProbe(
  bin: string,
  args: string[] = [],
  env: Record<string, string> = {},
): string {
  const reportPath = join(workdir, 'report.txt')
  const proc = Bun.spawnSync([bin, ...args], {
    env: {
      ...process.env,
      ...env,
      LD_PRELOAD: PROBE_SO,
      CRASHFUZZ_PROBE_OUT: reportPath,
    },
  })
  if (proc.exitCode !== 0) {
    throw new Error(`workload ${bin} exited ${proc.exitCode}: ${proc.stderr.toString()}`)
  }
  return reportPath
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crashfuzz-probe-'))

  const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, 'shim'), 'probe'])
  if (make.exitCode !== 0) {
    throw new Error(`building probe.so failed: ${make.stderr.toString()}`)
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('probe.so', () => {
  test('counts the write and fsync calls a libc workload makes', async () => {
    const bin = buildWorkload(
      'libc_writer',
      `
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        for (int i = 0; i < 3; i++) {
          if (write(fd, "abcd", 4) != 4) return 2;
        }
        if (pwrite(fd, "z", 1, 0) != 1) return 3;
        if (fsync(fd) != 0) return 4;
        if (fdatasync(fd) != 0) return 5;
        return close(fd);
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [join(workdir, 'data.bin')])).text()

    expect(report).toContain('crashfuzz-probe')
    expect(report).toMatch(/^\s+write\s+3$/m)
    expect(report).toMatch(/^\s+pwrite\s+1$/m)
    expect(report).toMatch(/^\s+fsync\s+1$/m)
    expect(report).toMatch(/^\s+fdatasync\s+1$/m)
    expect(report).toMatch(/bytes_written=13\b/)
  })

  test('counts rename, link, unlink and truncate', async () => {
    const bin = buildWorkload(
      'metadata_ops',
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        char a[512], b[512], c[512];
        snprintf(a, sizeof a, "%s/a", argv[1]);
        snprintf(b, sizeof b, "%s/b", argv[1]);
        snprintf(c, sizeof c, "%s/c", argv[1]);
        int fd = open(a, O_CREAT | O_RDWR, 0644);
        if (fd < 0) return 1;
        if (write(fd, "hello", 5) != 5) return 2;
        if (ftruncate(fd, 2) != 0) return 3;
        if (close(fd) != 0) return 4;
        if (link(a, b) != 0) return 5;
        if (rename(a, c) != 0) return 6;
        if (unlink(b) != 0) return 7;
        return unlink(c);
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [workdir])).text()

    expect(report).toMatch(/^\s+rename\s+1$/m)
    expect(report).toMatch(/^\s+link\s+1$/m)
    expect(report).toMatch(/^\s+unlink\s+2$/m)
    expect(report).toMatch(/^\s+ftruncate\s+1$/m)
  })

  test('reports no libc file I/O for a target that bypasses libc', async () => {
    // A target issuing raw syscalls stands in for a Go or statically linked
    // binary, which is the case criterion 6 exists to catch.
    const bin = buildWorkload(
      'raw_syscall_writer',
      `
      #include <fcntl.h>
      #include <sys/syscall.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        long fd = syscall(SYS_openat, AT_FDCWD, argv[1], O_CREAT | O_RDWR, 0644);
        if (fd < 0) return 1;
        if (syscall(SYS_write, fd, "abcd", 4) != 4) return 2;
        if (syscall(SYS_fsync, fd) != 0) return 3;
        return syscall(SYS_close, fd) == 0 ? 0 : 4;
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [join(workdir, 'raw.bin')])).text()

    expect(report).toContain('no libc file I/O observed')
    expect(report).toMatch(/total_calls=0\b/)
  })

  test('flags MAP_SHARED file mappings as an unobservable write path', async () => {
    // Stores through a shared mapping are invisible until msync, which is the
    // disqualifying property in docs/EXECUTION-PLAN.md section 7.2.
    const bin = buildWorkload(
      'mmap_writer',
      `
      #include <fcntl.h>
      #include <sys/mman.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR, 0644);
        if (fd < 0) return 1;
        if (ftruncate(fd, 4096) != 0) return 2;
        char *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (p == MAP_FAILED) return 3;
        p[0] = 'x';
        if (msync(p, 4096, MS_SYNC) != 0) return 4;
        if (munmap(p, 4096) != 0) return 5;
        return close(fd);
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [join(workdir, 'mapped.bin')])).text()

    expect(report).toMatch(/^\s+mmap\(MAP_SHARED\)\s+1$/m)
    expect(report).toMatch(/^\s+msync\s+1$/m)
  })

  test('counts the 64-bit call variants glibc exposes as separate symbols', async () => {
    // Rust's std::fs calls pwrite64 and ftruncate64 directly. Interposing only
    // pwrite and ftruncate observes none of redb's writes, which is how this
    // gap was found: strace reported 74 pwrite64 where the probe reported none.
    const bin = buildWorkload(
      'lfs_writer',
      `
      #define _LARGEFILE64_SOURCE
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (pwrite64(fd, "abcd", 4, 0) != 4) return 2;
        if (ftruncate64(fd, 2) != 0) return 3;
        return close(fd);
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [join(workdir, 'lfs.bin')])).text()

    expect(report).toMatch(/^\s+pwrite\s+1$/m)
    expect(report).toMatch(/^\s+ftruncate\s+1$/m)
  })

  test('flags a MAP_SHARED mapping made through mmap64', async () => {
    // SQLite is built with _FILE_OFFSET_BITS=64 and maps its WAL -shm file
    // through mmap64. Interposing only mmap reported no shared mapping for it,
    // which would have cleared a target whose write path we cannot observe.
    const bin = buildWorkload(
      'lfs_mmap_writer',
      `
      #define _FILE_OFFSET_BITS 64
      #include <fcntl.h>
      #include <sys/mman.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR, 0644);
        if (fd < 0) return 1;
        if (ftruncate(fd, 4096) != 0) return 2;
        char *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (p == MAP_FAILED) return 3;
        p[0] = 'x';
        if (munmap(p, 4096) != 0) return 4;
        return close(fd);
      }
      `,
    )

    const report = await Bun.file(runUnderProbe(bin, [join(workdir, 'lfs-mapped.bin')])).text()

    expect(report).toMatch(/^\s+mmap\(MAP_SHARED\)\s+1$/m)
  })
})
