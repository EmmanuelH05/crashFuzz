//! Workload for the primary target.
//!
//! Commits key-value pairs through redb and brackets each logical operation with
//! a marker, so the oracle knows exactly when redb acknowledged durability. The
//! marker file is named `crashfuzz.marker`, which the shim records inline and
//! keeps out of the traced data path.
//!
//!   redb-workload <db-path> <marker-path> <operations> <shape>
//!
//! Shapes, which are the Phase 4 sweep axis:
//!
//!   single      one writer, 4 KiB values, one commit per operation
//!   large       one writer, 256 KiB values, which cross redb's page boundaries
//!   many        one writer, 64 byte values, one commit per operation
//!   mixed       alternates Durability::Immediate and Durability::None
//!   concurrent  four writer threads contending for the write transaction
//!
//! `Durability::Immediate` is documented as persistent as soon as `commit`
//! returns, so those operations are acknowledged `durable=1` and the oracle
//! expects them to survive. `Durability::None` carries no such promise, so those
//! are acknowledged `durable=0` and their absence is never a violation. That is
//! the in-workload negative control from docs/model.md.

use redb::{Database, Durability, TableDefinition};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("kv");

/// One unbuffered write per marker. The shim takes the ordering stamp inside the
/// write call, so buffering would stamp the marker where the buffer flushed
/// rather than where the workload actually was.
fn marker(file: &Mutex<File>, text: &str) {
    let mut handle = file.lock().unwrap();
    let _ = handle.write_all(text.as_bytes());
}

fn digest_of(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Value bytes depend on the key, so a stale value read after recovery has a
/// different digest rather than colliding with the expected one.
fn value_for(key: &str, bytes: usize) -> Vec<u8> {
    let mut value = vec![b'a' + (key.len() % 26) as u8; bytes];
    let name = key.as_bytes();
    let copied = name.len().min(bytes);
    value[..copied].copy_from_slice(&name[..copied]);
    value
}

#[derive(Clone, Copy)]
struct Shape {
    value_bytes: usize,
    threads: usize,
    /// Every nth operation commits at Durability::None. Zero means never.
    non_durable_every: u64,
}

fn shape_for(name: &str) -> Shape {
    match name {
        "large" => Shape { value_bytes: 256 * 1024, threads: 1, non_durable_every: 0 },
        "many" => Shape { value_bytes: 64, threads: 1, non_durable_every: 0 },
        "mixed" => Shape { value_bytes: 4096, threads: 1, non_durable_every: 2 },
        "concurrent" => Shape { value_bytes: 4096, threads: 4, non_durable_every: 0 },
        _ => Shape { value_bytes: 4096, threads: 1, non_durable_every: 0 },
    }
}

fn run_operation(
    db: &Database,
    file: &Mutex<File>,
    op: u64,
    shape: &Shape,
) -> Result<(), Box<dyn std::error::Error>> {
    let key = format!("k{op}");
    let value = value_for(&key, shape.value_bytes);
    let durable = shape.non_durable_every == 0 || op % shape.non_durable_every != 0;

    marker(file, &format!("op={op} phase=begin kind=put key={key}"));

    let mut txn = db.begin_write()?;
    txn.set_durability(if durable { Durability::Immediate } else { Durability::None })?;
    {
        let mut table = txn.open_table(TABLE)?;
        table.insert(key.as_str(), value.as_slice())?;
    }
    // The ack marker is written only after commit returned. Writing it earlier
    // would have the oracle expect a durability redb never claimed.
    txn.commit()?;

    marker(
        file,
        &format!(
            "op={op} phase=ack kind=put key={key} digest={} durable={}",
            digest_of(&value),
            if durable { 1 } else { 0 }
        ),
    );

    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: {} <db-path> <marker-path> <operations> <shape>", args[0]);
        std::process::exit(2);
    }

    let operations: u64 = args[3].parse()?;
    let shape = shape_for(&args[4]);

    let file = Arc::new(Mutex::new(File::create(&args[2])?));
    let db = Arc::new(Database::create(&args[1])?);

    if shape.threads <= 1 {
        for op in 1..=operations {
            run_operation(&db, &file, op, &shape)?;
        }
        return Ok(());
    }

    // Contending writers. redb serializes write transactions, so this exercises
    // the queueing path rather than concurrent writes to the file, and it is the
    // shape that puts the trace's total ordering under real pressure.
    let next = Arc::new(AtomicU64::new(1));
    let mut handles = Vec::new();

    for _ in 0..shape.threads {
        let db = Arc::clone(&db);
        let file = Arc::clone(&file);
        let next = Arc::clone(&next);

        handles.push(std::thread::spawn(move || loop {
            let op = next.fetch_add(1, Ordering::SeqCst);
            if op > operations {
                break;
            }
            run_operation(&db, &file, op, &shape).expect("operation failed");
        }));
    }

    for handle in handles {
        handle.join().expect("writer thread panicked");
    }

    Ok(())
}
