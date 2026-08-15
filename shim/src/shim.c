/*
 * shim.so - LD_PRELOAD interposer that records a target's file I/O.
 *
 * Trace format v1: newline-delimited JSON. The first line is a header, every
 * following line is one intercepted call.
 *
 *   LD_PRELOAD=shim/build/shim.so CRASHFUZZ_TRACE_DIR=<dir> <workload>
 *
 * Trace output uses syscall(SYS_write) rather than libc write() so that it does
 * not re-enter the interposer.
 */

#include "sha256.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#define EXPORT __attribute__((visibility("default")))
#define TRACE_VERSION 1
#define RECORD_MAX 4096

static int trace_fd = -1;
static char cas_dir[PATH_MAX];

/*
 * The ordering counter lives in a MAP_SHARED page so that a forked child keeps
 * stamping from the same sequence as its parent. A private counter would be
 * copied at fork and both processes would emit the same indices.
 */
static atomic_ullong *shared_index;
static atomic_ullong fallback_index;

static unsigned long long next_stamp(void)
{
    atomic_ullong *counter = shared_index != NULL ? shared_index : &fallback_index;
    return atomic_fetch_add(counter, 1ULL);
}

#define REAL(sym, type)                                                        \
    static type real_##sym;                                                    \
    if (real_##sym == NULL)                                                    \
        real_##sym = (type)dlsym(RTLD_NEXT, #sym);

typedef ssize_t (*write_fn)(int, const void *, size_t);
typedef ssize_t (*pwrite_fn)(int, const void *, size_t, off_t);
typedef int (*open_fn)(const char *, int, ...);
typedef int (*close_fn)(int);
typedef off_t (*lseek_fn)(int, off_t, int);
typedef int (*int_fd_fn)(int);
typedef int (*sync_file_range_fn)(int, off64_t, off64_t, unsigned int);
typedef int (*ftruncate_fn)(int, off_t);
typedef int (*truncate_fn)(const char *, off_t);
typedef int (*mkdir_fn)(const char *, mode_t);
typedef int (*unlink_fn)(const char *);
typedef int (*path_pair_fn)(const char *, const char *);
typedef ssize_t (*writev_fn)(int, const struct iovec *, int);

/*
 * Descriptors at or above MAX_FD are traced without a path. 4 KiB per entry
 * holds any path the kernel will accept, so a stored path is never truncated.
 */
#define MAX_FD 1024
#define PATH_MAX_LEN PATH_MAX

/*
 * Paths are resolved once at open and cached per descriptor. Resolving at write
 * time would race with concurrent renames of the same path.
 */
static char fd_paths[MAX_FD][PATH_MAX_LEN];

#define MARKER_BASENAME "crashfuzz.marker"
#define MARKER_TEXT_MAX 512

/* Descriptors open on the marker file, tracked so their writes are not traced
 * as target I/O. */
static char fd_is_marker[MAX_FD];

static int path_is_marker(const char *path)
{
    const char *slash = strrchr(path, '/');
    const char *base = slash == NULL ? path : slash + 1;
    return strcmp(base, MARKER_BASENAME) == 0;
}

/*
 * Resolves a path that was given relative to a directory descriptor. Absolute
 * paths and AT_FDCWD go through realpath; otherwise the directory's own path is
 * read from /proc/self/fd and the relative name appended.
 */
static const char *resolve_at(int dirfd, const char *path, char out[PATH_MAX])
{
    if (path[0] == '/' || dirfd == AT_FDCWD) {
        if (realpath(path, out) != NULL)
            return out;
        return path;
    }

    char link[80];
    snprintf(link, sizeof link, "/proc/self/fd/%d", dirfd);

    char dir[PATH_MAX];
    ssize_t n = readlink(link, dir, sizeof dir - 1);
    if (n < 0)
        return path;
    dir[n] = '\0';

    size_t dir_len = strlen(dir);
    size_t rel_len = strlen(path);
    if (dir_len + 1 + rel_len + 1 > PATH_MAX)
        return path;

    memcpy(out, dir, dir_len);
    out[dir_len] = '/';
    memcpy(out + dir_len + 1, path, rel_len + 1);
    return out;
}

/* Caches the resolved path for a descriptor. */
static void remember_path(int fd, const char *path)
{
    if (fd < 0 || fd >= MAX_FD)
        return;

    fd_is_marker[fd] = (char)path_is_marker(path);

    char resolved[PATH_MAX];
    if (realpath(path, resolved) != NULL)
        snprintf(fd_paths[fd], PATH_MAX_LEN, "%s", resolved);
    else
        snprintf(fd_paths[fd], PATH_MAX_LEN, "%s", path);
}

static const char *path_for(int fd)
{
    if (fd < 0 || fd >= MAX_FD)
        return "";
    return fd_paths[fd];
}

/** Returns the offset a completed write landed at, or -1 if unknown. */
static long long write_offset(int fd, ssize_t written)
{
    REAL(lseek, lseek_fn)
    if (written < 0)
        return -1;

    off_t after = real_lseek(fd, 0, SEEK_CUR);
    if (after < 0)
        return -1;
    return (long long)after - written;
}

static void emit(const char *record, size_t len)
{
    if (trace_fd < 0)
        return;
    syscall(SYS_write, trace_fd, record, len);
}

__attribute__((constructor)) static void trace_open(void)
{
    const char *dir = getenv("CRASHFUZZ_TRACE_DIR");
    if (dir == NULL)
        return;

    char path[4096];
    int n = snprintf(path, sizeof path, "%s/trace-%d.jsonl", dir, (int)getpid());
    if (n < 0 || (size_t)n >= sizeof path)
        return;

    trace_fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                            O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (trace_fd < 0)
        return;

    void *page = mmap(NULL, sizeof(atomic_ullong), PROT_READ | PROT_WRITE,
                      MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (page != MAP_FAILED) {
        shared_index = (atomic_ullong *)page;
        atomic_store(shared_index, 0ULL);
    }

    n = snprintf(cas_dir, sizeof cas_dir, "%s/cas", dir);
    if (n < 0 || (size_t)n >= sizeof cas_dir)
        cas_dir[0] = '\0';
    else
        syscall(SYS_mkdirat, AT_FDCWD, cas_dir, 0755);

    char header[RECORD_MAX];
    int len = snprintf(header, sizeof header,
                       "{\"rec\":\"header\",\"v\":%d,\"pid\":%d}\n",
                       TRACE_VERSION, (int)getpid());
    emit(header, (size_t)len);
}

/*
 * Writes a payload into the content-addressed store unless an object with the
 * same digest is already there. O_EXCL makes the check and the create one
 * operation, so concurrent writers cannot both create the same object.
 */
static void store_payload(const char *digest, const void *data, size_t len)
{
    if (cas_dir[0] == '\0')
        return;

    char path[PATH_MAX];
    int n = snprintf(path, sizeof path, "%s/%s", cas_dir, digest);
    if (n < 0 || (size_t)n >= sizeof path)
        return;

    int fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd < 0)
        return;

    size_t written = 0;
    while (written < len) {
        long n_written = syscall(SYS_write, fd, (const char *)data + written, len - written);
        if (n_written <= 0)
            break;
        written += (size_t)n_written;
    }
    syscall(SYS_close, fd);
}

/*
 * Thread id from gettid(2), cached per thread. The value identifies the thread
 * within the process and appears in every record it produces.
 */
static int thread_id(void)
{
    static __thread int cached;
    if (cached == 0)
        cached = (int)syscall(SYS_gettid);
    return cached;
}

/*
 * Submission and completion stamps come from one counter, so a record carries
 * both the order in which the call was issued and the order in which it
 * returned. emit_event is called after the underlying call, so it takes the
 * completion stamp itself.
 */
static void emit_event(unsigned long long index, const char *call, int fd,
                       const char *path, const char *path2, long long offset,
                       size_t length, long long ret, int err, const char *digest)
{
    unsigned long long completion = next_stamp();

    char record[RECORD_MAX];
    int len = snprintf(record, sizeof record,
                       "{\"rec\":\"event\",\"i\":%llu,\"j\":%llu,\"call\":\"%s\","
                       "\"fd\":%d,\"tid\":%d,\"path\":\"%s\",\"path2\":\"%s\","
                       "\"off\":%lld,\"len\":%zu,\"ret\":%lld,\"err\":%d,\"dig\":\"%s\"}\n",
                       index, completion, call, fd, thread_id(),
                       path == NULL ? "" : path, path2 == NULL ? "" : path2,
                       offset, length, ret, err, digest == NULL ? "" : digest);
    emit(record, (size_t)len);
}

/** Resolves path against the filesystem, falling back to the argument as given. */
static const char *resolve(const char *path, char out[PATH_MAX])
{
    if (realpath(path, out) != NULL)
        return out;
    return path;
}

/** Digests and stores a payload, returning its hex digest in out. */
static void capture_payload(const void *data, size_t len, char out[SHA256_HEX_BYTES])
{
    sha256_hex(data, len, out);
    store_payload(out, data, len);
}

/* Marker text is written by the workload driver to delimit logical operations. */
static void emit_marker(unsigned long long index, const void *text, size_t len)
{
    size_t copied = len < MARKER_TEXT_MAX ? len : MARKER_TEXT_MAX;

    char record[RECORD_MAX];
    int n = snprintf(record, sizeof record,
                     "{\"rec\":\"marker\",\"i\":%llu,\"tid\":%d,\"text\":\"%.*s\"}\n",
                     index, thread_id(), (int)copied, (const char *)text);
    emit(record, (size_t)n);
}

static int is_marker_fd(int fd)
{
    return fd >= 0 && fd < MAX_FD && fd_is_marker[fd];
}

EXPORT ssize_t write(int fd, const void *buf, size_t count)
{
    REAL(write, write_fn)

    if (is_marker_fd(fd)) {
        unsigned long long marker_index = next_stamp();
        emit_marker(marker_index, buf, count);
        return real_write(fd, buf, count);
    }

    unsigned long long index = next_stamp();
    ssize_t ret = real_write(fd, buf, count);
    int err = ret < 0 ? errno : 0;

    char digest[SHA256_HEX_BYTES];
    capture_payload(buf, count, digest);
    emit_event(index, "write", fd, path_for(fd), NULL, write_offset(fd, ret), count, ret, err, digest);
    return ret;
}

EXPORT ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset)
{
    REAL(pwrite, pwrite_fn)

    unsigned long long index = next_stamp();
    ssize_t ret = real_pwrite(fd, buf, count, offset);
    int err = ret < 0 ? errno : 0;

    char digest[SHA256_HEX_BYTES];
    capture_payload(buf, count, digest);
    emit_event(index, "pwrite", fd, path_for(fd), NULL, (long long)offset, count, ret, err, digest);
    return ret;
}

EXPORT int open(const char *path, int flags, ...)
{
    REAL(open, open_fn)

    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    unsigned long long index = next_stamp();
    int fd = real_open(path, flags, mode);
    int err = fd < 0 ? errno : 0;

    remember_path(fd, path);
    emit_event(index, "open", fd, path_for(fd), NULL, 0, 0, fd, err, NULL);
    return fd;
}

EXPORT int fsync(int fd)
{
    REAL(fsync, int_fd_fn)

    unsigned long long index = next_stamp();
    int ret = real_fsync(fd);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "fsync", fd, path_for(fd), NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int fdatasync(int fd)
{
    REAL(fdatasync, int_fd_fn)

    unsigned long long index = next_stamp();
    int ret = real_fdatasync(fd);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "fdatasync", fd, path_for(fd), NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int sync_file_range(int fd, off64_t offset, off64_t nbytes, unsigned int flags)
{
    REAL(sync_file_range, sync_file_range_fn)

    unsigned long long index = next_stamp();
    int ret = real_sync_file_range(fd, offset, nbytes, flags);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "sync_file_range", fd, path_for(fd), NULL, (long long)offset, (size_t)nbytes, ret, err, NULL);
    return ret;
}

EXPORT int ftruncate(int fd, off_t length)
{
    REAL(ftruncate, ftruncate_fn)

    unsigned long long index = next_stamp();
    int ret = real_ftruncate(fd, length);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "ftruncate", fd, path_for(fd), NULL, 0, (size_t)length, ret, err, NULL);
    return ret;
}

EXPORT int truncate(const char *path, off_t length)
{
    REAL(truncate, truncate_fn)

    char resolved[PATH_MAX];
    const char *full = resolve(path, resolved);

    unsigned long long index = next_stamp();
    int ret = real_truncate(path, length);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "truncate", -1, full, NULL, 0, (size_t)length, ret, err, NULL);
    return ret;
}

EXPORT int mkdir(const char *path, mode_t mode)
{
    REAL(mkdir, mkdir_fn)

    unsigned long long index = next_stamp();
    int ret = real_mkdir(path, mode);
    int err = ret < 0 ? errno : 0;

    char resolved[PATH_MAX];
    emit_event(index, "mkdir", -1, resolve(path, resolved), NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int unlink(const char *path)
{
    REAL(unlink, unlink_fn)

    /* Resolved before the call because the entry is gone afterwards. */
    char resolved[PATH_MAX];
    const char *full = resolve(path, resolved);

    unsigned long long index = next_stamp();
    int ret = real_unlink(path);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "unlink", -1, full, NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int link(const char *from, const char *to)
{
    REAL(link, path_pair_fn)

    char from_buf[PATH_MAX];
    const char *from_full = resolve(from, from_buf);

    unsigned long long index = next_stamp();
    int ret = real_link(from, to);
    int err = ret < 0 ? errno : 0;

    char to_buf[PATH_MAX];
    emit_event(index, "link", -1, from_full, resolve(to, to_buf), 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int rename(const char *from, const char *to)
{
    REAL(rename, path_pair_fn)

    char from_buf[PATH_MAX];
    const char *from_full = resolve(from, from_buf);

    unsigned long long index = next_stamp();
    int ret = real_rename(from, to);
    int err = ret < 0 ? errno : 0;

    char to_buf[PATH_MAX];
    emit_event(index, "rename", -1, from_full, resolve(to, to_buf), 0, 0, ret, err, NULL);
    return ret;
}

/*
 * glibc exposes 64-bit variants of the offset-taking calls as distinct symbols.
 * Rust's std::fs and any caller built with _FILE_OFFSET_BITS=64 reach these
 * names, so both spellings are interposed and recorded under one call name.
 */
EXPORT ssize_t pwrite64(int fd, const void *buf, size_t count, off64_t offset)
{
    typedef ssize_t (*pwrite64_fn)(int, const void *, size_t, off64_t);
    REAL(pwrite64, pwrite64_fn)

    unsigned long long index = next_stamp();
    ssize_t ret = real_pwrite64(fd, buf, count, offset);
    int err = ret < 0 ? errno : 0;

    char digest[SHA256_HEX_BYTES];
    capture_payload(buf, count, digest);
    emit_event(index, "pwrite", fd, path_for(fd), NULL, (long long)offset, count, ret, err, digest);
    return ret;
}

EXPORT int ftruncate64(int fd, off64_t length)
{
    typedef int (*ftruncate64_fn)(int, off64_t);
    REAL(ftruncate64, ftruncate64_fn)

    unsigned long long index = next_stamp();
    int ret = real_ftruncate64(fd, length);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "ftruncate", fd, path_for(fd), NULL, 0, (size_t)length, ret, err, NULL);
    return ret;
}

EXPORT int truncate64(const char *path, off64_t length)
{
    typedef int (*truncate64_fn)(const char *, off64_t);
    REAL(truncate64, truncate64_fn)

    char resolved[PATH_MAX];
    const char *full = resolve(path, resolved);

    unsigned long long index = next_stamp();
    int ret = real_truncate64(path, length);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "truncate", -1, full, NULL, 0, (size_t)length, ret, err, NULL);
    return ret;
}

EXPORT int open64(const char *path, int flags, ...)
{
    typedef int (*open64_fn)(const char *, int, ...);
    REAL(open64, open64_fn)

    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    unsigned long long index = next_stamp();
    int fd = real_open64(path, flags, mode);
    int err = fd < 0 ? errno : 0;

    remember_path(fd, path);
    emit_event(index, "open", fd, path_for(fd), NULL, 0, 0, fd, err, NULL);
    return fd;
}

/*
 * Vectored writes are digested over the concatenation of their buffers, which
 * is the byte range the call actually writes. Payloads larger than the staging
 * buffer are recorded without a digest rather than with a partial one.
 */
#define IOV_STAGE_MAX (64 * 1024)

EXPORT ssize_t writev(int fd, const struct iovec *iov, int iovcnt)
{
    REAL(writev, writev_fn)

    size_t total = 0;
    for (int i = 0; i < iovcnt; i++)
        total += iov[i].iov_len;

    static __thread char stage[IOV_STAGE_MAX];
    int staged = total <= IOV_STAGE_MAX;
    if (staged) {
        size_t at = 0;
        for (int i = 0; i < iovcnt; i++) {
            memcpy(stage + at, iov[i].iov_base, iov[i].iov_len);
            at += iov[i].iov_len;
        }
    }

    unsigned long long index = next_stamp();
    ssize_t ret = real_writev(fd, iov, iovcnt);
    int err = ret < 0 ? errno : 0;

    char digest[SHA256_HEX_BYTES] = "";
    if (staged)
        capture_payload(stage, total, digest);

    emit_event(index, "writev", fd, path_for(fd), NULL, write_offset(fd, ret), total, ret, err,
               staged ? digest : NULL);
    return ret;
}

EXPORT int openat(int dirfd, const char *path, int flags, ...)
{
    typedef int (*openat_fn)(int, const char *, int, ...);
    REAL(openat, openat_fn)

    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    unsigned long long index = next_stamp();
    int fd = real_openat(dirfd, path, flags, mode);
    int err = fd < 0 ? errno : 0;

    char resolved[PATH_MAX];
    remember_path(fd, resolve_at(dirfd, path, resolved));
    if (!is_marker_fd(fd))
        emit_event(index, "open", fd, path_for(fd), NULL, 0, 0, fd, err, NULL);
    return fd;
}

EXPORT int renameat(int fromfd, const char *from, int tofd, const char *to)
{
    typedef int (*renameat_fn)(int, const char *, int, const char *);
    REAL(renameat, renameat_fn)

    char from_buf[PATH_MAX];
    const char *from_full = resolve_at(fromfd, from, from_buf);

    unsigned long long index = next_stamp();
    int ret = real_renameat(fromfd, from, tofd, to);
    int err = ret < 0 ? errno : 0;

    char to_buf[PATH_MAX];
    emit_event(index, "rename", -1, from_full, resolve_at(tofd, to, to_buf), 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int renameat2(int fromfd, const char *from, int tofd, const char *to, unsigned int flags)
{
    typedef int (*renameat2_fn)(int, const char *, int, const char *, unsigned int);
    REAL(renameat2, renameat2_fn)

    char from_buf[PATH_MAX];
    const char *from_full = resolve_at(fromfd, from, from_buf);

    unsigned long long index = next_stamp();
    int ret = real_renameat2(fromfd, from, tofd, to, flags);
    int err = ret < 0 ? errno : 0;

    char to_buf[PATH_MAX];
    emit_event(index, "rename", -1, from_full, resolve_at(tofd, to, to_buf), (long long)flags, 0,
               ret, err, NULL);
    return ret;
}

EXPORT int unlinkat(int dirfd, const char *path, int flags)
{
    typedef int (*unlinkat_fn)(int, const char *, int);
    REAL(unlinkat, unlinkat_fn)

    char resolved[PATH_MAX];
    const char *full = resolve_at(dirfd, path, resolved);

    unsigned long long index = next_stamp();
    int ret = real_unlinkat(dirfd, path, flags);
    int err = ret < 0 ? errno : 0;

    emit_event(index, "unlink", -1, full, NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int linkat(int fromfd, const char *from, int tofd, const char *to, int flags)
{
    typedef int (*linkat_fn)(int, const char *, int, const char *, int);
    REAL(linkat, linkat_fn)

    char from_buf[PATH_MAX];
    const char *from_full = resolve_at(fromfd, from, from_buf);

    unsigned long long index = next_stamp();
    int ret = real_linkat(fromfd, from, tofd, to, flags);
    int err = ret < 0 ? errno : 0;

    char to_buf[PATH_MAX];
    emit_event(index, "link", -1, from_full, resolve_at(tofd, to, to_buf), 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int mkdirat(int dirfd, const char *path, mode_t mode)
{
    typedef int (*mkdirat_fn)(int, const char *, mode_t);
    REAL(mkdirat, mkdirat_fn)

    unsigned long long index = next_stamp();
    int ret = real_mkdirat(dirfd, path, mode);
    int err = ret < 0 ? errno : 0;

    char resolved[PATH_MAX];
    emit_event(index, "mkdir", -1, resolve_at(dirfd, path, resolved), NULL, 0, 0, ret, err, NULL);
    return ret;
}

EXPORT int close(int fd)
{
    REAL(close, close_fn)

    unsigned long long index = next_stamp();
    int ret = real_close(fd);
    int err = ret < 0 ? errno : 0;

    if (!is_marker_fd(fd))
        emit_event(index, "close", fd, path_for(fd), NULL, 0, 0, ret, err, NULL);

    if (fd >= 0 && fd < MAX_FD) {
        fd_paths[fd][0] = '\0';
        fd_is_marker[fd] = 0;
    }
    return ret;
}
