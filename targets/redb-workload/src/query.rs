//! Recovery and query for the primary target.
//!
//! Opens a crash image with redb, which is where redb runs its own recovery,
//! then reports redb's own integrity check and the digest of every value it can
//! read. Both judgements belong to the target: docs/model.md rests
//! CORRUPT_INVARIANT on the target's integrity check rather than on any
//! invariant this project invents for it.
//!
//!   redb-query <db-path>
//!
//! Output, one field per line:
//!
//!   integrity=ok
//!   k1 <64 hex chars>
//!
//! A database that will not open exits non-zero with the reason on stderr, which
//! the caller reports as RECOVERY_FAILED rather than treating as a crash of the
//! harness.

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use sha2::{Digest, Sha256};
use std::env;

const TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("kv");

fn digest_of(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: {} <db-path>", args[0]);
        std::process::exit(2);
    }

    // Opening is redb's recovery path. Anything it rejects here it would reject
    // for a real user with the same image.
    let mut db = match Database::open(&args[1]) {
        Ok(db) => db,
        Err(error) => {
            eprintln!("open: {error}");
            std::process::exit(1);
        }
    };

    // redb's own checker, not ours.
    let integrity_ok = match db.check_integrity() {
        Ok(ok) => ok,
        Err(error) => {
            eprintln!("check_integrity: {error}");
            false
        }
    };
    println!("integrity={}", if integrity_ok { "ok" } else { "failed" });

    let read = match db.begin_read() {
        Ok(read) => read,
        Err(error) => {
            eprintln!("begin_read: {error}");
            std::process::exit(1);
        }
    };

    // A missing table is not a harness failure. Recovery may legally have rolled
    // the database back to before the table existed, and the oracle decides
    // whether that lost anything acknowledged.
    let table = match read.open_table(TABLE) {
        Ok(table) => table,
        Err(error) => {
            eprintln!("open_table: {error}");
            return;
        }
    };

    let iter = match table.iter() {
        Ok(iter) => iter,
        Err(error) => {
            eprintln!("iter: {error}");
            return;
        }
    };

    for entry in iter {
        match entry {
            Ok((key, value)) => println!("{} {}", key.value(), digest_of(value.value())),
            Err(error) => eprintln!("row: {error}"),
        }
    }
}
