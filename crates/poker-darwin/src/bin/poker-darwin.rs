// SPDX-License-Identifier: MIT
//
// poker-darwin CLI — the eval harness. Subcommands:
//   solve   : train a CFR solver and print the exploitability convergence curve
//   evolve  : run Darwin Mode (evolve the solver policy) and print the learning curve
//   exploit : train and report final exploitability + game value
//   equity  : (feature `realgames`) real Texas Hold'em equity via rs_poker
//   abstract: (feature `ruvector`) information-set abstraction via ruvector
//   neural  : (feature `neural`) Deep-CFR advantage network via candle

use poker_darwin::cfr::{CfrVariant, Solver, SolverConfig};
use poker_darwin::darwin::{evolve, DarwinConfig};
use poker_darwin::exploit::{exploitability, profile_value};
use poker_darwin::game::Game;
use poker_darwin::games::{KuhnPoker, LeducHoldem};
use std::collections::HashMap;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args.get(1..).unwrap_or(&[]).to_vec();
    let flags = parse_flags(rest);

    match cmd {
        "solve" => cmd_solve(&flags),
        "exploit" => cmd_exploit(&flags),
        "evolve" => cmd_evolve(&flags),
        "info" => cmd_info(&flags),
        "equity" => cmd_equity(rest, &flags),
        "abstract" => cmd_abstract(&flags),
        "neural" => cmd_neural(&flags),
        "help" | "-h" | "--help" => print_help(),
        other => {
            eprintln!("unknown command: {other}\n");
            print_help();
            std::process::exit(2);
        }
    }
}

// ---- shared helpers -------------------------------------------------------

#[derive(Default)]
struct Flags(HashMap<String, String>);

impl Flags {
    fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(String::as_str)
    }
    fn str_or<'a>(&'a self, k: &str, d: &'a str) -> &'a str {
        self.get(k).unwrap_or(d)
    }
    fn u64_or(&self, k: &str, d: u64) -> u64 {
        self.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn usize_or(&self, k: &str, d: usize) -> usize {
        self.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
}

fn parse_flags(args: &[String]) -> Flags {
    let mut m = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            let val = args.get(i + 1).filter(|v| !v.starts_with("--")).cloned();
            if let Some(v) = val {
                m.insert(name.to_string(), v);
                i += 2;
            } else {
                m.insert(name.to_string(), "true".to_string());
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    Flags(m)
}

fn parse_variant(s: &str) -> CfrVariant {
    match s {
        "vanilla" => CfrVariant::Vanilla,
        "linear" => CfrVariant::Linear,
        "dcfr" => CfrVariant::Dcfr {
            alpha: 1.5,
            beta: 0.0,
            gamma: 2.0,
        },
        _ => CfrVariant::CfrPlus,
    }
}

// ---- solve / exploit ------------------------------------------------------

fn cmd_solve(flags: &Flags) {
    let iters = flags.u64_or("iters", 1000);
    let every = flags.u64_or("every", (iters / 10).max(1));
    let variant = parse_variant(flags.str_or("variant", "cfr+"));
    match flags.str_or("game", "kuhn") {
        "leduc" => solve_curve(LeducHoldem::new(), variant, iters, every),
        _ => solve_curve(KuhnPoker::new(), variant, iters, every),
    }
}

fn solve_curve<G: Game>(game: G, variant: CfrVariant, iters: u64, every: u64) {
    println!(
        "== solve {} | variant={} | {iters} iterations ==",
        game.name(),
        variant.tag()
    );
    println!(
        "{:>10}  {:>14}  {:>14}",
        "iters", "exploitability", "game value(p0)"
    );
    let mut solver = Solver::new(game, SolverConfig::new(variant));
    let mut done = 0u64;
    while done < iters {
        let step = every.min(iters - done);
        solver.train(step);
        done += step;
        let avg = solver.average_strategy();
        let e = exploitability(solver.game(), &avg);
        let v = profile_value(solver.game(), &avg);
        println!("{done:>10}  {e:>14.6}  {v:>14.6}");
    }
    println!("infosets: {}", solver.num_infosets());
}

fn cmd_exploit(flags: &Flags) {
    let iters = flags.u64_or("iters", 2000);
    let variant = parse_variant(flags.str_or("variant", "cfr+"));
    match flags.str_or("game", "kuhn") {
        "leduc" => report_final(LeducHoldem::new(), variant, iters),
        _ => report_final(KuhnPoker::new(), variant, iters),
    }
}

fn report_final<G: Game>(game: G, variant: CfrVariant, iters: u64) {
    let mut solver = Solver::new(game, SolverConfig::new(variant));
    solver.train(iters);
    let avg = solver.average_strategy();
    println!(
        "game={} variant={} iters={iters}",
        solver.game().name(),
        variant.tag()
    );
    println!(
        "exploitability = {:.6}",
        exploitability(solver.game(), &avg)
    );
    println!(
        "game value (p0) = {:.6}",
        profile_value(solver.game(), &avg)
    );
}

// ---- info (environment / tree size) --------------------------------------

fn cmd_info(flags: &Flags) {
    match flags.str_or("game", "kuhn") {
        "leduc" => print_info(LeducHoldem::new()),
        "kuhn" => print_info(KuhnPoker::new()),
        "all" => {
            print_info(KuhnPoker::new());
            println!();
            print_info(LeducHoldem::new());
        }
        other => {
            eprintln!("unknown game: {other} (use kuhn|leduc|all)");
            std::process::exit(2);
        }
    }
}

fn print_info<G: Game>(game: G) {
    let st = poker_darwin::game::tree_stats(&game);
    println!("== environment: {} ==", game.name());
    println!("  information sets : {}", st.infosets);
    println!("  decision nodes   : {}", st.decision_nodes);
    println!("  chance nodes     : {}", st.chance_nodes);
    println!("  terminal leaves  : {}", st.terminal_nodes);
    println!(
        "  total histories  : {}",
        st.decision_nodes + st.chance_nodes + st.terminal_nodes
    );
    println!("  max depth        : {}", st.max_depth);
    println!("  utility unit     : chips (1 ante); exploitability reported in the same unit");
}

// ---- evolve (Darwin self-learning) ---------------------------------------

fn cmd_evolve(flags: &Flags) {
    let cfg = DarwinConfig {
        population: flags.usize_or("population", 12),
        generations: flags.usize_or("generations", 8),
        eval_iterations: flags.u64_or("eval-iters", 200),
        seed: flags.u64_or("seed", 0xC0FFEE),
        elite: flags.usize_or("elite", 3),
    };
    match flags.str_or("game", "kuhn") {
        "leduc" => run_evolve(LeducHoldem::new(), cfg),
        _ => run_evolve(KuhnPoker::new(), cfg),
    }
}

fn run_evolve<G: Game + Clone>(game: G, cfg: DarwinConfig) {
    println!(
        "== Darwin evolve {} | pop={} gens={} eval_iters={} seed={:#x} ==",
        game.name(),
        cfg.population,
        cfg.generations,
        cfg.eval_iterations,
        cfg.seed
    );
    let report = evolve(&game, &cfg);
    let h = cfg.eval_iterations;
    println!(
        "baseline (vanilla CFR @ {h} it): exploitability = {:.6}\n",
        report.baseline_exploitability
    );
    println!(
        "{:>4}  {:>14}  {:>14}  champion",
        "gen", "champ_exploit", "mean_exploit"
    );
    for g in &report.generations {
        println!(
            "{:>4}  {:>14.6}  {:>14.6}  {}",
            g.index,
            g.champion_exploitability,
            g.mean_exploitability,
            g.champion.label()
        );
    }
    let improvement = if report.baseline_exploitability > 0.0 {
        100.0 * (report.baseline_exploitability - report.champion_exploitability)
            / report.baseline_exploitability
    } else {
        0.0
    };
    let dyn_edge = if report.best_static_exploitability > 0.0 {
        100.0 * (report.best_static_exploitability - report.best_dynamic_exploitability)
            / report.best_static_exploitability
    } else {
        0.0
    };
    println!("\nchampion         : {}", report.champion.label());
    println!("  dynamic?       : {}", report.champion.is_dynamic());
    println!("champion exploit : {:.6}", report.champion_exploitability);
    println!("baseline exploit : {:.6}", report.baseline_exploitability);
    println!("improvement      : {improvement:.1}% lower exploitability than vanilla");
    println!("\n-- SOTA lever: best static vs best non-stationary genome --");
    println!(
        "best STATIC      : {:.6}",
        report.best_static_exploitability
    );
    println!(
        "best DYNAMIC     : {:.6}",
        report.best_dynamic_exploitability
    );
    println!("dynamic edge     : {dyn_edge:.1}% lower exploitability than best static");
    println!("\n-- champion lineage (seed -> champion) --");
    for step in &report.champion_ancestry {
        println!("   {step}");
    }
    println!("\nevaluated genomes: {}", report.lineage.len());
    println!("receipt (fnv1a)  : {}", report.receipt);
}

// ---- feature-gated subcommands -------------------------------------------

#[cfg(feature = "realgames")]
fn cmd_equity(rest: &[String], flags: &Flags) {
    // Positional hands are the leading args before any `--flag`.
    let hands: Vec<String> = rest
        .iter()
        .take_while(|a| !a.starts_with("--"))
        .cloned()
        .collect();
    if hands.len() < 2 {
        eprintln!("usage: poker-darwin equity <hand1> <hand2> [...] [--iters N]");
        eprintln!("example: poker-darwin equity AsKs QdQh --iters 100000");
        std::process::exit(2);
    }
    let iters = flags.usize_or("iters", 100_000);
    match poker_darwin::realgames::equity(&hands, iters) {
        Ok(eq) => {
            println!("== Texas Hold'em equity ({iters} Monte Carlo rollouts, rs_poker) ==");
            for (h, e) in hands.iter().zip(eq) {
                println!("  {h:>8} : {:.2}%", e * 100.0);
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(feature = "realgames"))]
fn cmd_equity(_rest: &[String], _flags: &Flags) {
    eprintln!("`equity` needs the `realgames` feature: cargo run -p poker-darwin --features realgames -- equity ...");
    std::process::exit(2);
}

#[cfg(feature = "ruvector")]
fn cmd_abstract(flags: &Flags) {
    let iters = flags.u64_or("iters", 1000);
    let buckets = flags.usize_or("buckets", 8);
    poker_darwin::abstraction::demo(iters, buckets);
}

#[cfg(not(feature = "ruvector"))]
fn cmd_abstract(_flags: &Flags) {
    eprintln!("`abstract` needs the `ruvector` feature: cargo run -p poker-darwin --features ruvector -- abstract ...");
    std::process::exit(2);
}

#[cfg(feature = "neural")]
fn cmd_neural(flags: &Flags) {
    let epochs = flags.usize_or("epochs", 200);
    poker_darwin::neural::demo(epochs);
}

#[cfg(not(feature = "neural"))]
fn cmd_neural(_flags: &Flags) {
    eprintln!("`neural` needs the `neural` feature: cargo run -p poker-darwin --features neural -- neural ...");
    std::process::exit(2);
}

fn print_help() {
    println!(
        "poker-darwin — CFR poker solver + Darwin self-learning\n\n\
         USAGE:\n\
         \x20 poker-darwin info     --game <kuhn|leduc|all>                     (environment / tree size)\n\
         \x20 poker-darwin solve    --game <kuhn|leduc> --iters N [--variant cfr+|vanilla|linear|dcfr] [--every K]\n\
         \x20 poker-darwin exploit  --game <kuhn|leduc> --iters N [--variant ...]\n\
         \x20 poker-darwin evolve   --game <kuhn|leduc> [--generations G --population P --eval-iters N --seed S]\n\
         \x20 poker-darwin equity   <hand1> <hand2> [--iters N]            (needs --features realgames)\n\
         \x20 poker-darwin abstract --game <kuhn|leduc> [--buckets B]      (needs --features ruvector)\n\
         \x20 poker-darwin neural   [--epochs E]                           (needs --features neural)\n"
    );
}
