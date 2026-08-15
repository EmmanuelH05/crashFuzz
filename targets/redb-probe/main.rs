//! Phase 0 criterion 6 workload.
//!
//! Commits a handful of transactions at both durability levels so the syscalls
//! redb issues on its write path can be compared between `strace -f -c` and
//! `LD_PRELOAD=shim/build/probe.so`. If the two disagree, redb is not fully
//! observable through libc interposition and the Phase 1 mechanism must change.
//!
//!   cargo run --release -- /var/lib/crashfuzz/probe.redb

use redb::{Database, Durability, ReadableDatabase, ReadableTable, TableDefinition};
use std::env;

const TABLE: TableDefinition<u64, &[u8]> = TableDefinition::new("probe");

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args().nth(1).ok_or("usage: redb-probe <db-path>")?;
    let _ = std::fs::remove_file(&path);

    let db = Database::create(&path)?;

    for i in 0..8u64 {
        let mut txn = db.begin_write()?;
        // Alternating levels exercise both the fsync-bearing commit path and the
        // one that defers persistence, which is the distinction the oracle rests on.
        txn.set_durability(if i % 2 == 0 {
            Durability::Immediate
        } else {
            Durability::None
        })?;

        {
            let mut table = txn.open_table(TABLE)?;
            table.insert(i, vec![b'x'; 4096].as_slice())?;
        }
        txn.commit()?;
    }

    let read = db.begin_read()?;
    let table = read.open_table(TABLE)?;
    let count = table.iter()?.count();
    println!("redb-probe: {count} keys");

    Ok(())
}
