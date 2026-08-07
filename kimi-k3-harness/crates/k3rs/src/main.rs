//! k3rs — Kimi K3 inference in Rust. A faithful port of kimi-k3-in-c's verified
//! in-memory path (full-recompute greedy decode), conformance-checked against the
//! same torch reference via tools/cmp_logits.py.
//!
//!   k3rs <model_dir> --ids 3,7,11,5,9 --gen 4 [--dump-logits PATH]

mod bench;
mod json;
mod model;
mod ops;
mod st;
#[cfg(test)]
mod tests;

use model::{argmax, Model};
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut dir: Option<String> = None;
    let mut ids: Vec<usize> = Vec::new();
    let mut gen = 8usize;
    let mut dump: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--ids" => {
                i += 1;
                ids = args[i]
                    .split(',')
                    .filter_map(|s| s.trim().parse::<usize>().ok())
                    .collect();
            }
            "--gen" => {
                i += 1;
                gen = args[i].parse().unwrap_or(8);
            }
            "--dump-logits" => {
                i += 1;
                dump = Some(args[i].clone());
            }
            "--bench" => {
                bench::run();
                return;
            }
            "--help" | "-h" => {
                eprintln!("usage: k3rs <model_dir> --ids 1,2,3 [--gen N] [--dump-logits PATH]");
                return;
            }
            other => {
                if dir.is_none() && !other.starts_with("--") {
                    dir = Some(other.to_string());
                } else {
                    eprintln!("k3rs: unknown argument {other}");
                    std::process::exit(2);
                }
            }
        }
        i += 1;
    }
    let dir = match dir {
        Some(d) => d,
        None => {
            eprintln!("usage: k3rs <model_dir> --ids 1,2,3 [--gen N] [--dump-logits PATH]");
            std::process::exit(2);
        }
    };
    if ids.is_empty() {
        eprintln!("k3rs: --ids is required (the reproducible channel the tests use)");
        std::process::exit(2);
    }

    let t0 = std::time::Instant::now();
    let m = match Model::load(std::path::Path::new(&dir)) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("k3rs: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "k3rs: loaded {} layers, hidden {}, vocab {} in {:.2?}",
        m.cfg.n_layers,
        m.cfg.hidden,
        m.cfg.vocab,
        t0.elapsed()
    );

    let mut seq = ids.clone();
    let mut generated = Vec::new();
    let t1 = std::time::Instant::now();
    for g in 0..gen {
        let logits = m.forward(&seq);
        if g == 0 {
            if let Some(path) = &dump {
                let mut f = std::fs::File::create(path).expect("cannot open logits dump");
                for &v in &logits {
                    f.write_all(&v.to_le_bytes()).unwrap();
                }
                println!("wrote {} ({} float32 logits)", path, logits.len());
            }
        }
        let tok = argmax(&logits);
        generated.push(tok);
        seq.push(tok);
    }
    let dt = t1.elapsed().as_secs_f64();

    println!("--- generated ids ---");
    println!(
        "{}",
        generated
            .iter()
            .map(|t| t.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!(
        "{} tokens in {:.2} s, {:.3} s/token average (full recompute)",
        gen,
        dt,
        dt / gen.max(1) as f64
    );
}
