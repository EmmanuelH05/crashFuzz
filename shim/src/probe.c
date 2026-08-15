/*
 * probe.so - minimal LD_PRELOAD interposer for target selection (Phase 0).
 *
 * Answers one question: does a candidate target route its file I/O through
 * libc? A Go binary or a statically linked binary issues syscalls directly and
 * is invisible here, which disqualifies it from the LD_PRELOAD-based capture in
 * Phase 1. See docs/EXECUTION-PLAN.md section 7.1.
 *
 * This is not the trace shim. It records counts, not payloads, has no trace
 * format, and is not used after Phase 0.
 *
 *   LD_PRELOAD=shim/build/probe.so <workload>
 *
 * The report goes to stderr at exit, or to the file named by
 * CRASHFUZZ_PROBE_OUT.
 */

/* _GNU_SOURCE comes from the Makefile's CFLAGS. */
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <unistd.h>

#define EXPORT __attribute__((visibility("default")))

/* Ordered to match the report; keep COUNTER_NAMES in sync. */
enum counter {
    C_WRITE,
    C_PWRITE,
    C_FSYNC,
    C_FDATASYNC,
    C_RENAME,
    C_LINK,
    C_UNLINK,
    C_FTRUNCATE,
    C_MMAP_SHARED,
    C_MSYNC,
    C__COUNT,
};

static const char *const COUNTER_NAMES[C__COUNT] = {
    "write",
    "pwrite",
    "fsync",
    "fdatasync",
    "rename",
    "link",
    "unlink",
    "ftruncate",
    "mmap(MAP_SHARED)",
    "msync",
};

static atomic_ullong counters[C__COUNT];
static atomic_ullong bytes_written;

/*
 * dlsym can call libc functions this file interposes, so each wrapper resolves
 * its own real symbol lazily. The probe records counts only, so a benign race
 * on first resolution is acceptable; the trace shim in Phase 1 needs the
 * stricter bootstrap described in docs/EXECUTION-PLAN.md section 5.
 */
#define REAL(sym, type)                                                        \
    static type real_##sym;                                                    \
    if (real_##sym == NULL)                                                    \
        real_##sym = (type)dlsym(RTLD_NEXT, #sym);

#define BUMP(c) atomic_fetch_add(&counters[c], 1ULL)

typedef ssize_t (*write_fn)(int, const void *, size_t);
typedef ssize_t (*pwrite_fn)(int, const void *, size_t, off_t);
typedef int (*int_fd_fn)(int);
typedef int (*rename_fn)(const char *, const char *);
typedef int (*link_fn)(const char *, const char *);
typedef int (*unlink_fn)(const char *);
typedef int (*ftruncate_fn)(int, off_t);
typedef void *(*mmap_fn)(void *, size_t, int, int, int, off_t);
typedef int (*msync_fn)(void *, size_t, int);

EXPORT ssize_t write(int fd, const void *buf, size_t count)
{
    REAL(write, write_fn)
    BUMP(C_WRITE);
    ssize_t ret = real_write(fd, buf, count);
    if (ret > 0)
        atomic_fetch_add(&bytes_written, (unsigned long long)ret);
    return ret;
}

EXPORT ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset)
{
    REAL(pwrite, pwrite_fn)
    BUMP(C_PWRITE);
    ssize_t ret = real_pwrite(fd, buf, count, offset);
    if (ret > 0)
        atomic_fetch_add(&bytes_written, (unsigned long long)ret);
    return ret;
}

/*
 * glibc exposes pwrite64 and ftruncate64 as symbols distinct from pwrite and
 * ftruncate. Rust's std::fs calls the 64-bit names directly, so interposing
 * only the base names observes none of a Rust target's writes. Both variants
 * increment the same counter.
 */
EXPORT ssize_t pwrite64(int fd, const void *buf, size_t count, off64_t offset)
{
    typedef ssize_t (*pwrite64_fn)(int, const void *, size_t, off64_t);
    REAL(pwrite64, pwrite64_fn)
    BUMP(C_PWRITE);
    ssize_t ret = real_pwrite64(fd, buf, count, offset);
    if (ret > 0)
        atomic_fetch_add(&bytes_written, (unsigned long long)ret);
    return ret;
}

EXPORT int ftruncate64(int fd, off64_t length)
{
    typedef int (*ftruncate64_fn)(int, off64_t);
    REAL(ftruncate64, ftruncate64_fn)
    BUMP(C_FTRUNCATE);
    return real_ftruncate64(fd, length);
}

EXPORT int fsync(int fd)
{
    REAL(fsync, int_fd_fn)
    BUMP(C_FSYNC);
    return real_fsync(fd);
}

EXPORT int fdatasync(int fd)
{
    REAL(fdatasync, int_fd_fn)
    BUMP(C_FDATASYNC);
    return real_fdatasync(fd);
}

EXPORT int rename(const char *from, const char *to)
{
    REAL(rename, rename_fn)
    BUMP(C_RENAME);
    return real_rename(from, to);
}

EXPORT int link(const char *from, const char *to)
{
    REAL(link, link_fn)
    BUMP(C_LINK);
    return real_link(from, to);
}

EXPORT int unlink(const char *path)
{
    REAL(unlink, unlink_fn)
    BUMP(C_UNLINK);
    return real_unlink(path);
}

EXPORT int ftruncate(int fd, off_t length)
{
    REAL(ftruncate, ftruncate_fn)
    BUMP(C_FTRUNCATE);
    return real_ftruncate(fd, length);
}

/*
 * A non-zero count here means the target may write through a shared mapping,
 * where stores are invisible to this interposer until msync.
 */
EXPORT void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset)
{
    REAL(mmap, mmap_fn)
    if ((flags & MAP_SHARED) && fd >= 0)
        BUMP(C_MMAP_SHARED);
    return real_mmap(addr, length, prot, flags, fd, offset);
}

/* Callers built with _FILE_OFFSET_BITS=64, such as SQLite, reach mmap64. */
EXPORT void *mmap64(void *addr, size_t length, int prot, int flags, int fd, off64_t offset)
{
    typedef void *(*mmap64_fn)(void *, size_t, int, int, int, off64_t);
    REAL(mmap64, mmap64_fn)
    if ((flags & MAP_SHARED) && fd >= 0)
        BUMP(C_MMAP_SHARED);
    return real_mmap64(addr, length, prot, flags, fd, offset);
}

EXPORT int msync(void *addr, size_t length, int flags)
{
    REAL(msync, msync_fn)
    BUMP(C_MSYNC);
    return real_msync(addr, length, flags);
}

__attribute__((destructor)) static void report(void)
{
    FILE *out = stderr;
    const char *out_path = getenv("CRASHFUZZ_PROBE_OUT");
    if (out_path != NULL) {
        FILE *f = fopen(out_path, "w");
        if (f != NULL)
            out = f;
    }

    unsigned long long total = 0;
    for (int i = 0; i < C__COUNT; i++)
        total += atomic_load(&counters[i]);

    fprintf(out, "crashfuzz-probe pid=%d total_calls=%llu bytes_written=%llu\n",
            (int)getpid(), total, atomic_load(&bytes_written));

    for (int i = 0; i < C__COUNT; i++) {
        unsigned long long n = atomic_load(&counters[i]);
        if (n > 0)
            fprintf(out, "  %-18s %llu\n", COUNTER_NAMES[i], n);
    }

    if (total == 0)
        fprintf(out, "  no libc file I/O observed - target is not LD_PRELOAD traceable\n");

    if (out != stderr)
        fclose(out);
}
