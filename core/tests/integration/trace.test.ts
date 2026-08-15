/**
 * Phase 1 trace capture. Runs C workloads under shim.so and checks the trace it
 * produces.
 *
 * Linux only. Run with: bun run test:vm core/tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SHIM_SO = join(REPO_ROOT, 'shim', 'build', 'shim.so')

let workdir: string

type TraceRecord = Record<string, unknown>

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

/** Runs a binary under shim.so in a fresh trace directory. */
function trace(bin: string, args: string[] = []): string {
  const traceDir = mkdtempSync(join(workdir, 'trace-'))
  const proc = Bun.spawnSync([bin, ...args], {
    env: { ...process.env, LD_PRELOAD: SHIM_SO, CRASHFUZZ_TRACE_DIR: traceDir },
  })
  if (proc.exitCode !== 0) {
    throw new Error(`workload ${bin} exited ${proc.exitCode}: ${proc.stderr.toString()}`)
  }
  return traceDir
}

/** Parses every trace segment in a trace directory into records. */
async function readTrace(traceDir: string): Promise<TraceRecord[]> {
  const segments = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'))
  const records: TraceRecord[] = []

  for (const segment of segments) {
    const text = await Bun.file(join(traceDir, segment)).text()
    for (const line of text.split('\n')) {
      if (line.trim() !== '') records.push(JSON.parse(line))
    }
  }
  return records
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'crashfuzz-trace-'))

  const make = Bun.spawnSync(['make', '-C', join(REPO_ROOT, 'shim')])
  if (make.exitCode !== 0) {
    throw new Error(`building shim.so failed: ${make.stderr.toString()}`)
  }
})

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('shim.so', () => {
  test('writes a versioned header and one record per write', async () => {
    const bin = buildWorkload(
      'single_write',
      `
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (write(fd, "abcd", 4) != 4) return 2;
        return close(fd);
      }
      `,
    )

    const records = await readTrace(trace(bin, [join(workdir, 'single.bin')]))

    expect(records[0]).toMatchObject({ rec: 'header', v: 1 })

    const writes = records.filter((r) => r.rec === 'event' && r.call === 'write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ len: 4, ret: 4, err: 0 })
  })

  test('resolves the path at open and reports the offset each write landed at', async () => {
    const bin = buildWorkload(
      'append_then_pwrite',
      `
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (write(fd, "aaaa", 4) != 4) return 2;
        if (write(fd, "bbbb", 4) != 4) return 3;
        if (pwrite(fd, "cc", 2, 1) != 2) return 4;
        return close(fd);
      }
      `,
    )
    const target = join(workdir, 'offsets.bin')

    const records = await readTrace(trace(bin, [target]))
    const writes = records.filter((r) => r.rec === 'event' && r.call !== 'open')

    expect(writes.map((r) => [r.call, r.off, r.len])).toEqual([
      ['write', 0, 4],
      ['write', 4, 4],
      ['pwrite', 1, 2],
      ['close', 0, 0],
    ])
    expect(writes.every((r) => r.path === target)).toBe(true)
  })

  test('stores payloads content-addressed, one object per distinct payload', async () => {
    const bin = buildWorkload(
      'repeated_payload',
      `
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        for (int i = 0; i < 3; i++) {
          if (write(fd, "same", 4) != 4) return 2;
        }
        if (write(fd, "diff", 4) != 4) return 3;
        return close(fd);
      }
      `,
    )

    const traceDir = trace(bin, [join(workdir, 'payloads.bin')])
    const records = await readTrace(traceDir)
    const writes = records.filter((r) => r.call === 'write')

    const digests = writes.map((r) => r.dig as string)
    expect(digests[0]).toBe(digests[1])
    expect(digests[1]).toBe(digests[2])
    expect(digests[3]).not.toBe(digests[0])

    const objects = readdirSync(join(traceDir, 'cas'))
    expect(objects.sort()).toEqual([...new Set(digests)].sort())
    expect(await Bun.file(join(traceDir, 'cas', digests[0]!)).text()).toBe('same')
  })

  test('digests match SHA-256 across the padding block boundary', async () => {
    // 200 bytes needs two padding blocks, 4 bytes needs one. Both are checked
    // against digests computed outside the shim.
    const bin = buildWorkload(
      'digest_vectors',
      `
      #include <fcntl.h>
      #include <string.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        char big[200];
        memset(big, 'x', sizeof big);
        if (write(fd, "same", 4) != 4) return 2;
        if (write(fd, big, sizeof big) != (ssize_t)sizeof big) return 3;
        return close(fd);
      }
      `,
    )

    const records = await readTrace(trace(bin, [join(workdir, 'vectors.bin')]))
    const digests = records.filter((r) => r.call === 'write').map((r) => r.dig)

    expect(digests).toEqual([
      '0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
      'aa20c23e3201834050679e1d88941b9a6fed0557c9a705cb2c315e2e63fd486d',
    ])
  })

  test('records the persistence calls with the file they applied to', async () => {
    const bin = buildWorkload(
      'persistence_calls',
      `
      #define _GNU_SOURCE
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (write(fd, "abcd", 4) != 4) return 2;
        if (fsync(fd) != 0) return 3;
        if (fdatasync(fd) != 0) return 4;
        if (sync_file_range(fd, 0, 4, SYNC_FILE_RANGE_WRITE) != 0) return 5;
        return close(fd);
      }
      `,
    )
    const target = join(workdir, 'persist.bin')

    const records = await readTrace(trace(bin, [target]))
    const persistence = records.filter((r) =>
      ['fsync', 'fdatasync', 'sync_file_range'].includes(r.call as string),
    )

    expect(persistence.map((r) => r.call)).toEqual(['fsync', 'fdatasync', 'sync_file_range'])
    expect(persistence.every((r) => r.path === target && r.ret === 0)).toBe(true)
  })

  test('records metadata calls with both operands', async () => {
    const bin = buildWorkload(
      'metadata_calls',
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <sys/stat.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        char dir[512], a[512], b[512], c[512];
        snprintf(dir, sizeof dir, "%s/d", argv[1]);
        snprintf(a, sizeof a, "%s/d/a", argv[1]);
        snprintf(b, sizeof b, "%s/d/b", argv[1]);
        snprintf(c, sizeof c, "%s/d/c", argv[1]);
        if (mkdir(dir, 0755) != 0) return 1;
        int fd = open(a, O_CREAT | O_RDWR, 0644);
        if (fd < 0) return 2;
        if (write(fd, "hello", 5) != 5) return 3;
        if (ftruncate(fd, 3) != 0) return 4;
        if (close(fd) != 0) return 5;
        if (truncate(a, 2) != 0) return 6;
        if (link(a, b) != 0) return 7;
        if (rename(a, c) != 0) return 8;
        if (unlink(b) != 0) return 9;
        return unlink(c);
      }
      `,
    )

    const records = await readTrace(trace(bin, [workdir]))
    const metadata = records.filter((r) =>
      ['mkdir', 'truncate', 'link', 'rename', 'unlink', 'ftruncate'].includes(r.call as string),
    )

    expect(metadata.map((r) => r.call)).toEqual([
      'mkdir',
      'ftruncate',
      'truncate',
      'link',
      'rename',
      'unlink',
      'unlink',
    ])

    const rename = metadata.find((r) => r.call === 'rename')!
    expect(rename.path).toBe(join(workdir, 'd', 'a'))
    expect(rename.path2).toBe(join(workdir, 'd', 'c'))

    const ftruncate = metadata.find((r) => r.call === 'ftruncate')!
    expect(ftruncate).toMatchObject({ path: join(workdir, 'd', 'a'), len: 3 })
  })

  test('records calls made through the 64-bit symbol variants', async () => {
    // Rust's std::fs reaches pwrite64 and ftruncate64, and code built with
    // _FILE_OFFSET_BITS=64 reaches open64. Interposing only the base names
    // drops those calls from the trace.
    const bin = buildWorkload(
      'lfs_calls',
      `
      #define _FILE_OFFSET_BITS 64
      #define _LARGEFILE64_SOURCE
      #include <fcntl.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open64(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        if (pwrite64(fd, "abcd", 4, 8) != 4) return 2;
        if (ftruncate64(fd, 6) != 0) return 3;
        return close(fd);
      }
      `,
    )
    const target = join(workdir, 'lfs.bin')

    const records = await readTrace(trace(bin, [target]))
    const events = records.filter((r) => r.rec === 'event')

    expect(events.map((r) => r.call)).toEqual(['open', 'pwrite', 'ftruncate', 'close'])
    expect(events.find((r) => r.call === 'pwrite')).toMatchObject({ off: 8, len: 4, path: target })
    expect(events.find((r) => r.call === 'ftruncate')).toMatchObject({ len: 6, path: target })
  })

  test('records a thread id and both submission and completion order', async () => {
    const bin = buildWorkload(
      'threaded_writes',
      `
      #include <fcntl.h>
      #include <pthread.h>
      #include <stdio.h>
      #include <unistd.h>

      static char dir[512];

      static void *worker(void *arg) {
        long id = (long)arg;
        char path[512];
        snprintf(path, sizeof path, "%s/t%ld", dir, id);
        int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return NULL;
        for (int i = 0; i < 20; i++) {
          write(fd, "abcd", 4);
          fsync(fd);
        }
        close(fd);
        return NULL;
      }

      int main(int argc, char **argv) {
        snprintf(dir, sizeof dir, "%s", argv[1]);
        pthread_t threads[4];
        for (long i = 0; i < 4; i++) {
          if (pthread_create(&threads[i], NULL, worker, (void *)i) != 0) return 1;
        }
        for (int i = 0; i < 4; i++) pthread_join(threads[i], NULL);
        return 0;
      }
      `,
    )

    const records = await readTrace(trace(bin, [workdir]))
    const events = records.filter((r) => r.rec === 'event')

    // Submission and completion stamps come from one counter, so together they
    // cover 0..2N-1 exactly once and give a total order over both points.
    const stamps = events.flatMap((r) => [r.i as number, r.j as number])
    expect([...stamps].sort((a, b) => a - b)).toEqual(
      Array.from({ length: stamps.length }, (_, n) => n),
    )

    const threadIds = new Set(events.map((r) => r.tid))
    expect(threadIds.size).toBe(4)

    // A call completes after it was submitted, so its completion index is
    // always the larger of the two.
    expect(events.every((r) => (r.j as number) > (r.i as number))).toBe(true)
  })

  test('digests a vectored write over the concatenated buffers', async () => {
    const bin = buildWorkload(
      'vectored_write',
      `
      #include <fcntl.h>
      #include <sys/uio.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        struct iovec iov[2] = {
          { .iov_base = (void *)"sa", .iov_len = 2 },
          { .iov_base = (void *)"me", .iov_len = 2 },
        };
        if (writev(fd, iov, 2) != 4) return 2;
        return close(fd);
      }
      `,
    )
    const traceDir = trace(bin, [join(workdir, 'vectored.bin')])
    const records = await readTrace(traceDir)
    const writev = records.find((r) => r.call === 'writev')!

    expect(writev).toMatchObject({
      off: 0,
      len: 4,
      ret: 4,
      dig: '0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
    })
    expect(await Bun.file(join(traceDir, 'cas', writev.dig as string)).text()).toBe('same')
  })

  test('records marker writes inline and keeps them out of the target data path', async () => {
    // The workload driver writes to a file named crashfuzz.marker to mark where
    // a logical operation begins and ends. The shim records the marker in the
    // trace and does not treat it as target I/O.
    const bin = buildWorkload(
      'marker_channel',
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <string.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        char marker_path[512], data_path[512];
        snprintf(marker_path, sizeof marker_path, "%s/crashfuzz.marker", argv[1]);
        snprintf(data_path, sizeof data_path, "%s/data.bin", argv[1]);

        int mfd = open(marker_path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
        if (mfd < 0) return 1;
        int fd = open(data_path, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 2;

        const char *begin = "op=1 phase=begin";
        if (write(mfd, begin, strlen(begin)) < 0) return 3;
        if (write(fd, "abcd", 4) != 4) return 4;
        const char *end = "op=1 phase=end";
        if (write(mfd, end, strlen(end)) < 0) return 5;

        close(fd);
        return close(mfd);
      }
      `,
    )

    const records = await readTrace(trace(bin, [workdir]))

    expect(records.filter((r) => r.rec === 'marker').map((r) => r.text)).toEqual([
      'op=1 phase=begin',
      'op=1 phase=end',
    ])

    const writes = records.filter((r) => r.rec === 'event' && r.call === 'write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ path: join(workdir, 'data.bin'), len: 4 })
  })

  test('trace of the rename-based update protocol matches the derived sequence', async () => {
    // Expected sequence, derived by hand from the workload source:
    //
    //   1  open   dir/f.tmp   O_CREAT|O_RDWR|O_TRUNC
    //   2  write  dir/f.tmp   off 0   len 8
    //   3  fsync  dir/f.tmp
    //   4  close  dir/f.tmp
    //   5  rename dir/f.tmp -> dir/f
    //   6  open   dir         O_RDONLY
    //   7  fsync  dir
    //   8  close  dir
    //
    // The directory fsync is what makes the rename durable; ALICE reports
    // omitting it as a crash vulnerability.
    const bin = buildWorkload(
      'rename_protocol',
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
        if (write(fd, "payload8", 8) != 8) return 2;
        if (fsync(fd) != 0) return 3;
        if (close(fd) != 0) return 4;
        if (rename(tmp, final) != 0) return 5;

        int dirfd = open(argv[1], O_RDONLY);
        if (dirfd < 0) return 6;
        if (fsync(dirfd) != 0) return 7;
        return close(dirfd);
      }
      `,
    )
    const dir = mkdtempSync(join(workdir, 'protocol-'))

    const records = await readTrace(trace(bin, [dir]))
    const events = records.filter((r) => r.rec === 'event')

    expect(events.map((r) => [r.call, r.path, r.path2, r.off, r.len])).toEqual([
      ['open', join(dir, 'f.tmp'), '', 0, 0],
      ['write', join(dir, 'f.tmp'), '', 0, 8],
      ['fsync', join(dir, 'f.tmp'), '', 0, 0],
      ['close', join(dir, 'f.tmp'), '', 0, 0],
      ['rename', join(dir, 'f.tmp'), join(dir, 'f'), 0, 0],
      ['open', dir, '', 0, 0],
      ['fsync', dir, '', 0, 0],
      ['close', dir, '', 0, 0],
    ])
  })

  test('traces a 10,000-operation workload in under 60 seconds', async () => {
    const bin = buildWorkload(
      'ten_thousand_ops',
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int fd = open(argv[1], O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 1;
        char page[4096];
        for (int i = 0; i < 10000; i++) {
          snprintf(page, sizeof page, "record-%d", i);
          if (write(fd, page, sizeof page) != sizeof page) return 2;
          if (i % 100 == 0 && fsync(fd) != 0) return 3;
        }
        return close(fd);
      }
      `,
    )

    const started = performance.now()
    const traceDir = trace(bin, [join(workdir, 'bulk.bin')])
    const elapsedSeconds = (performance.now() - started) / 1000

    const records = await readTrace(traceDir)
    const events = records.filter((r) => r.rec === 'event')
    const traceBytes = readdirSync(traceDir)
      .filter((f) => f.endsWith('.jsonl'))
      .reduce((total, f) => total + statSync(join(traceDir, f)).size, 0)
    const casBytes = readdirSync(join(traceDir, 'cas')).reduce(
      (total, f) => total + statSync(join(traceDir, 'cas', f)).size,
      0,
    )

    console.log(
      `10k ops: ${elapsedSeconds.toFixed(1)}s, ${events.length} events, ` +
        `trace ${(traceBytes / 1e6).toFixed(1)} MB, payloads ${(casBytes / 1e6).toFixed(1)} MB`,
    )

    expect(events.filter((r) => r.call === 'write')).toHaveLength(10000)
    expect(elapsedSeconds).toBeLessThan(60)
  }, 120_000)

  test('keeps one ordering across a forked child', async () => {
    const bin = buildWorkload(
      'forking_writer',
      `
      #include <fcntl.h>
      #include <stdio.h>
      #include <sys/wait.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        char parent_path[512], child_path[512];
        snprintf(parent_path, sizeof parent_path, "%s/parent.bin", argv[1]);
        snprintf(child_path, sizeof child_path, "%s/child.bin", argv[1]);

        pid_t pid = fork();
        if (pid < 0) return 1;

        const char *path = pid == 0 ? child_path : parent_path;
        int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 2;
        if (write(fd, "abcd", 4) != 4) return 3;
        if (fsync(fd) != 0) return 4;
        if (close(fd) != 0) return 5;

        if (pid == 0) return 0;
        int status = 0;
        waitpid(pid, &status, 0);
        return status;
      }
      `,
    )
    const dir = mkdtempSync(join(workdir, 'fork-'))

    const records = await readTrace(trace(bin, [dir]))
    const events = records.filter((r) => r.rec === 'event')

    const parentWrites = events.filter((r) => r.path === join(dir, 'parent.bin'))
    const childWrites = events.filter((r) => r.path === join(dir, 'child.bin'))
    expect(parentWrites.length).toBeGreaterThan(0)
    expect(childWrites.length).toBeGreaterThan(0)

    // Both processes stamp from the same shared counter, so no two records in
    // the merged trace share an index.
    const stamps = events.flatMap((r) => [r.i as number, r.j as number])
    expect(new Set(stamps).size).toBe(stamps.length)
  })

  test('records the *at calls against the directory descriptor they resolve from', async () => {
    // Storage engines use openat, renameat2 and unlinkat to update files
    // relative to a directory they hold open.
    const bin = buildWorkload(
      'relative_calls',
      `
      #define _GNU_SOURCE
      #include <fcntl.h>
      #include <stdio.h>
      #include <unistd.h>
      int main(int argc, char **argv) {
        int dirfd = open(argv[1], O_RDONLY | O_DIRECTORY);
        if (dirfd < 0) return 1;

        int fd = openat(dirfd, "a", O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd < 0) return 2;
        if (write(fd, "abcd", 4) != 4) return 3;
        if (close(fd) != 0) return 4;

        if (renameat(dirfd, "a", dirfd, "b") != 0) return 5;
        if (unlinkat(dirfd, "b", 0) != 0) return 6;
        return close(dirfd);
      }
      `,
    )
    const dir = mkdtempSync(join(workdir, 'relative-'))

    const records = await readTrace(trace(bin, [dir]))
    const events = records.filter((r) => r.rec === 'event')

    expect(events.map((r) => r.call)).toEqual([
      'open',
      'open',
      'write',
      'close',
      'rename',
      'unlink',
      'close',
    ])
    expect(events.find((r) => r.call === 'write')!.path).toBe(join(dir, 'a'))
    expect(events.find((r) => r.call === 'rename')).toMatchObject({
      path: join(dir, 'a'),
      path2: join(dir, 'b'),
    })
    expect(events.find((r) => r.call === 'unlink')!.path).toBe(join(dir, 'b'))
  })
})
