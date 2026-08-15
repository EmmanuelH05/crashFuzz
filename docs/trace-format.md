# Trace format v1

Produced by `shim/src/shim.c`, read by `core/src/trace/reader.ts`.

A trace directory contains:

```
trace-<pid>.jsonl     one segment per process, newline-delimited JSON
cas/<sha256-hex>      payload objects, one per distinct payload
```

Every line is one JSON object. The first line of a segment is the header; the
rest are events and markers. Records are appended and never rewritten, so a
trace is readable while the target is still running.

## Header

```json
{"rec":"header","v":1,"pid":31337}
```

`v` is the format version. A reader that does not implement the version fails
rather than guessing.

## Event

```json
{"rec":"event","i":12,"j":13,"call":"pwrite","fd":7,"tid":31337,
 "path":"/var/lib/crashfuzz/db.redb","path2":"","off":4096,"len":4096,
 "ret":4096,"err":0,"flags":0,"t":1755285600123456789,
 "dig":"9f86d0818884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a0"}
```

| Field | Meaning |
|---|---|
| `i` | Stamp taken before the call was issued |
| `j` | Stamp taken after the call returned |
| `call` | Normalized call name (see below) |
| `fd` | Descriptor the call used, `-1` for path-only calls |
| `tid` | `gettid(2)` of the calling thread |
| `path` | Resolved path; for descriptor calls, the path cached at open |
| `path2` | Destination of `rename` and `link`, empty otherwise |
| `off` | Byte offset the call applied at; `renameat2` carries its flags here |
| `len` | Byte count, or the new size for `truncate` and `ftruncate` |
| `ret` | Return value of the underlying call |
| `err` | `errno` when `ret` is negative, `0` otherwise |
| `flags` | Open flags on `open` records, `0` elsewhere |
| `t` | `CLOCK_REALTIME` nanoseconds |
| `dig` | SHA-256 of the payload, empty for calls that carry none |

`i` and `j` come from one counter, so the two stamps of all events together
form a total order over submission and completion points. The counter lives in
a `MAP_SHARED` page, so a forked child continues the parent's sequence and
segments from several processes merge by sorting on `i`.

## Marker

```json
{"rec":"marker","i":11,"tid":31337,"text":"op=1 phase=begin"}
```

Written by the workload driver to a file named `crashfuzz.marker`. The shim
records the text inline and does not trace the marker file as target I/O, which
gives an exact interleaving point between logical operations and the syscall
stream without depending on wall-clock ordering. See
`docs/EXECUTION-PLAN.md` §4.

## Call names

Symbol variants are recorded under one name, because they are the same
operation: `pwrite` covers `pwrite` and `pwrite64`; `open` covers `open`,
`open64` and `openat`; `ftruncate` covers `ftruncate` and `ftruncate64`;
`truncate` covers `truncate` and `truncate64`; `rename` covers `rename`,
`renameat` and `renameat2`; `link` covers `link` and `linkat`; `unlink` covers
`unlink` and `unlinkat`; `mkdir` covers `mkdir` and `mkdirat`.

Recorded call names: `open`, `close`, `write`, `pwrite`, `writev`, `fsync`,
`fdatasync`, `sync_file_range`, `ftruncate`, `truncate`, `mkdir`, `unlink`,
`link`, `rename`.

## Payload store

Payload objects are named by the lowercase hex SHA-256 of their bytes and
created with `O_EXCL`, so a payload written many times is stored once and
concurrent writers cannot both create the same object. A trace plus its `cas`
directory is enough to reconstruct file contents without the target present;
`core/src/trace/replay.ts` does this.

## Limits

- Descriptors at or above 1024 are traced without a path.
- Vectored writes larger than 64 KiB are recorded without a digest rather than
  with a partial one.
- Marker text is truncated at 512 bytes.
- Stores through a `MAP_SHARED` mapping are not visible until `msync`. See
  `docs/coverage.md`.
