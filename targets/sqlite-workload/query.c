/*
 * Recovery and query for the SQLite control target.
 *
 * Opens a database, which is where SQLite runs its own recovery, then runs
 * SQLite's own integrity check and prints the digest of every value it can
 * read. Both judgements belong to the target: docs/model.md rests
 * CORRUPT_INVARIANT on the target's integrity check rather than on any
 * invariant this project invents for it.
 *
 *   sqlite-query <db-path>
 *
 * Output, one field per line:
 *
 *   integrity=ok
 *   k1 <64 hex chars>
 *
 * A database that will not open exits non-zero with the reason on stderr, which
 * the caller reports as RECOVERY_FAILED rather than treating as a crash of the
 * harness.
 */

#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>

#include "../../shim/src/sha256.h"

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: %s <db-path>\n", argv[0]);
        return 2;
    }

    sqlite3 *db = NULL;
    if (sqlite3_open_v2(argv[1], &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) {
        fprintf(stderr, "open: %s\n", db ? sqlite3_errmsg(db) : "unknown");
        return 1;
    }

    sqlite3_stmt *check = NULL;
    if (sqlite3_prepare_v2(db, "PRAGMA integrity_check", -1, &check, NULL) != SQLITE_OK) {
        fprintf(stderr, "integrity_check: %s\n", sqlite3_errmsg(db));
        return 1;
    }

    int integrity_ok = 0;
    if (sqlite3_step(check) == SQLITE_ROW) {
        const unsigned char *result = sqlite3_column_text(check, 0);
        integrity_ok = result && sqlite3_stricmp((const char *)result, "ok") == 0;
        if (!integrity_ok) {
            fprintf(stderr, "integrity_check: %s\n", result ? (const char *)result : "?");
        }
    }
    sqlite3_finalize(check);

    printf("integrity=%s\n", integrity_ok ? "ok" : "failed");

    sqlite3_stmt *rows = NULL;
    if (sqlite3_prepare_v2(db, "SELECT k, v FROM kv ORDER BY k", -1, &rows, NULL) != SQLITE_OK) {
        /* A missing table is not a harness failure. Recovery may legally have
         * rolled the database back to before the table existed, and the oracle
         * decides whether that lost anything acknowledged. */
        fprintf(stderr, "select: %s\n", sqlite3_errmsg(db));
        sqlite3_close(db);
        return 0;
    }

    char digest[SHA256_HEX_BYTES];
    while (sqlite3_step(rows) == SQLITE_ROW) {
        const unsigned char *key = sqlite3_column_text(rows, 0);
        const void *value = sqlite3_column_blob(rows, 1);
        int bytes = sqlite3_column_bytes(rows, 1);

        sha256_hex(value, (size_t)bytes, digest);
        printf("%s %s\n", key ? (const char *)key : "", digest);
    }

    sqlite3_finalize(rows);
    sqlite3_close(db);
    return 0;
}
