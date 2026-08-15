/*
 * A deliberately unsafe key-value store. This is the positive control.
 *
 * It uses the update protocol from Pillai et al. §2.2.2 with the durability
 * left out: write a temporary file, close it, rename it over the real name, and
 * then tell the caller the value is durable. There is no fsync of the file
 * before the rename and no fsync of the directory after it.
 *
 * On a filesystem that does not order the append before the rename, a crash can
 * leave the new name pointing at a file with no data in it. The value the
 * application promised is then gone, which is exactly the 2009 ext4 data loss
 * shape and exactly what this project exists to find.
 *
 *   unsafe-kv <dir> <marker-path> <operations>
 *
 * The bug is in this program, not in the filesystem. It exists so that a clean
 * run of the real control means something: an oracle that never fires would
 * pass the SQLite control trivially, and would pass it just as happily if the
 * whole pipeline were broken.
 */

#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../../shim/src/sha256.h"

#define VALUE_BYTES 4096

static int marker_fd = -1;

static void marker(const char *fmt, ...)
{
    char text[512];
    va_list args;
    va_start(args, fmt);
    int len = vsnprintf(text, sizeof text, fmt, args);
    va_end(args);

    if (len > 0 && marker_fd >= 0) {
        ssize_t written = write(marker_fd, text, (size_t)len);
        (void)written;
    }
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: %s <dir> <marker-path> <operations>\n", argv[0]);
        return 2;
    }

    const char *dir = argv[1];
    long operations = strtol(argv[3], NULL, 10);

    marker_fd = open(argv[2], O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (marker_fd < 0) {
        perror("open marker");
        return 1;
    }

    unsigned char value[VALUE_BYTES];
    char digest[SHA256_HEX_BYTES];

    for (long i = 1; i <= operations; i++) {
        char key[64], final[512], tmp[512];
        snprintf(key, sizeof key, "k%ld", i);
        snprintf(final, sizeof final, "%s/%s", dir, key);
        snprintf(tmp, sizeof tmp, "%s/%s.tmp", dir, key);

        memset(value, 'a' + (int)(i % 26), sizeof value);
        memcpy(value, key, strlen(key));
        sha256_hex(value, sizeof value, digest);

        marker("op=%ld phase=begin kind=put key=%s", i, key);

        int fd = open(tmp, O_CREAT | O_WRONLY | O_TRUNC, 0644);
        if (fd < 0) {
            perror("open tmp");
            return 1;
        }
        if (write(fd, value, sizeof value) != (ssize_t)sizeof value) {
            perror("write");
            return 1;
        }
        /* No fsync here. That omission is the bug. */
        if (close(fd) != 0) {
            perror("close");
            return 1;
        }
        if (rename(tmp, final) != 0) {
            perror("rename");
            return 1;
        }
        /* No fsync of the directory either, and the value is announced durable
         * anyway. A crash after this marker may leave the name with no data. */
        marker("op=%ld phase=ack kind=put key=%s digest=%s durable=1", i, key, digest);
    }

    close(marker_fd);
    return 0;
}
