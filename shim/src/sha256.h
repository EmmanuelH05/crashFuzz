/* SHA-256 (FIPS 180-4). Used to content-address trace payloads. */

#ifndef CRASHFUZZ_SHA256_H
#define CRASHFUZZ_SHA256_H

#include <stddef.h>

#define SHA256_DIGEST_BYTES 32
#define SHA256_HEX_BYTES 65

/** Writes the lowercase hex digest of len bytes at data into out. */
void sha256_hex(const void *data, size_t len, char out[SHA256_HEX_BYTES]);

#endif
