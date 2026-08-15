/*
 * SQLite control workload.
 *
 * SQLite is the control, not the primary: it is exhaustively tested and should
 * come back clean, so a violation reported against it is overwhelmingly likely
 * to be our oracle rather than its bug. See docs/target-selection.md.
 *
 * One row per logical operation, each in its own transaction, with a marker on
 * either side. The ack marker is written only after the commit returned, which
 * is what entitles the oracle to expect the row to survive a crash. The marker
 * file is named crashfuzz.marker so the shim records its text inline and keeps
 * it out of the traced data path.
 *
 *   sqlite-workload <db-path> <marker-path> <operations>
 *
 * Settings are pinned to docs/model.md: WAL journal mode, synchronous=FULL. At
 * synchronous=NORMAL SQLite documents that recently committed transactions may
 * be lost after a power failure, which would make every finding here expected
 * behavior.
 */

#include <fcntl.h>
#include <sqlite3.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../../shim/src/sha256.h"

#define VALUE_BYTES 4096

static int marker_fd = -1;

/*
 * One write per marker, unbuffered. The shim takes the ordering stamp inside
 * the write call, so buffering would stamp the marker where the buffer flushed
 * rather than where the workload actually was.
 */
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

static void fail(sqlite3 *db, const char *what)
{
    fprintf(stderr, "%s: %s\n", what, db ? sqlite3_errmsg(db) : "no handle");
    exit(1);
}

static void exec_or_die(sqlite3 *db, const char *sql)
{
    char *error = NULL;
    if (sqlite3_exec(db, sql, NULL, NULL, &error) != SQLITE_OK) {
        fprintf(stderr, "%s: %s\n", sql, error ? error : "unknown");
        exit(1);
    }
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: %s <db-path> <marker-path> <operations>\n", argv[0]);
        return 2;
    }

    const char *db_path = argv[1];
    const char *marker_path = argv[2];
    long operations = strtol(argv[3], NULL, 10);

    marker_fd = open(marker_path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (marker_fd < 0) {
        perror("open marker");
        return 1;
    }

    sqlite3 *db = NULL;
    if (sqlite3_open(db_path, &db) != SQLITE_OK) fail(db, "open");

    /* Both pragmas are part of the durability contract the oracle checks, so
     * neither may be left at its default. */
    exec_or_die(db, "PRAGMA journal_mode=WAL");
    exec_or_die(db, "PRAGMA synchronous=FULL");
    exec_or_die(db, "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB)");

    unsigned char value[VALUE_BYTES];
    char digest[SHA256_HEX_BYTES];

    for (long i = 1; i <= operations; i++) {
        char key[64];
        snprintf(key, sizeof key, "k%ld", i);

        /* Value bytes depend on the operation number, so a stale value read
         * back after recovery has a different digest rather than colliding
         * with the one the oracle expected. */
        memset(value, 'a' + (int)(i % 26), sizeof value);
        memcpy(value, key, strlen(key));
        sha256_hex(value, sizeof value, digest);

        marker("op=%ld phase=begin kind=put key=%s", i, key);

        sqlite3_stmt *stmt = NULL;
        if (sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", -1, &stmt,
                               NULL) != SQLITE_OK) {
            fail(db, "prepare");
        }
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_STATIC);
        sqlite3_bind_blob(stmt, 2, value, (int)sizeof value, SQLITE_STATIC);

        if (sqlite3_step(stmt) != SQLITE_DONE) fail(db, "step");
        sqlite3_finalize(stmt);

        marker("op=%ld phase=ack kind=put key=%s digest=%s durable=1", i, key, digest);
    }

    if (sqlite3_close(db) != SQLITE_OK) fail(db, "close");
    close(marker_fd);
    return 0;
}
