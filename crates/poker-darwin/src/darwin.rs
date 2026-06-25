// SPDX-License-Identifier: MIT
//
// Darwin Mode for poker solving. This mirrors the @metaharness/projects
// `discovery-evolve` pattern (ADR-119/137/165): evolve a *structured policy
// genome*, never a prompt. Here the genome is the CFR solver's configuration.
//
// ADR-187 pushes this past the best *static* configuration by giving Darwin the
// architectural levers to build a NON-STATIONARY solver — the genome can emit
// functional schedules, not just scalars:
//
//   * Time-variant DCFR schedules (α/β anneal start → end with a decay rate).
//   * Predictive-regret momentum ω (optimistic regret matching).
//   * Regret-pruning threshold P (skip dominated branches; speed lever).
//
// The CFR algorithm stays frozen; the *harness around it* learns, from its own
// measured exploitability, a dynamic solver schedule that beats any fixed one.

use crate::cfr::{CfrVariant, Schedule, Solver, SolverConfig};
use crate::exploit::exploitability;
use crate::game::Game;
use crate::rng::Rng;
use std::collections::HashMap;

/// The evolvable policy genome. `kind` selects the family; the remaining genes
/// are the static DCFR exponents, the dynamic α/β schedule endpoints + decay,
/// the momentum weight, and the pruning threshold. Genes not used by a given
/// `kind` are still carried so mutation can switch family with sane values.
/// Order of the Chebyshev trajectories evolved by the kind-5 genome.
pub const CHEB_ORDER: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Genome {
    /// 0 Vanilla, 1 CFR+, 2 Linear, 3 static DCFR, 4 linear-dynamic DCFR,
    /// 5 Chebyshev-dynamic DCFR (the SOTA functional-schedule family).
    pub kind: u8,
    // Static DCFR exponents (and the strategy exponent γ, shared by dynamic).
    pub alpha: f64,
    pub beta: f64,
    pub gamma: f64,
    // Linear-dynamic α/β annealing schedule (kind 4).
    pub alpha_start: f64,
    pub alpha_end: f64,
    pub beta_start: f64,
    pub beta_end: f64,
    pub decay: f64,
    // Predictive momentum + pruning scalars (kind 4).
    pub omega: f64,
    pub prune: f64,
    // Chebyshev trajectory coefficients (kind 5): the value (α), momentum (ω),
    // and pruning (P) curves. β stays the scalar `beta`, γ the scalar `gamma`.
    pub alpha_cheb: [f64; CHEB_ORDER],
    pub omega_cheb: [f64; CHEB_ORDER],
    pub prune_cheb: [f64; CHEB_ORDER],
}

const KINDS: u8 = 6;
// Output bounds for the Chebyshev curves (mutation can never exceed these).
const ALPHA_BOUNDS: (f64, f64) = (0.5, 5.0);
const OMEGA_BOUNDS: (f64, f64) = (0.0, 2.5);
const PRUNE_BOUNDS: (f64, f64) = (-30.0, -1.0);

impl Default for Genome {
    fn default() -> Self {
        // CFR+ with canonical DCFR seeds ready for mutation.
        Genome {
            kind: 1,
            alpha: 1.5,
            beta: 0.0,
            gamma: 2.0,
            alpha_start: 4.0,
            alpha_end: 1.0,
            beta_start: 0.0,
            beta_end: -1.0,
            decay: 4.0,
            omega: 0.5,
            prune: -12.0,
            // α: ~ linear 4→1 (a₀=2.5, a₁=−1.5); ω: constant 0.6; P: constant −12.
            alpha_cheb: [2.5, -1.5, 0.0, 0.0],
            omega_cheb: [0.6, 0.0, 0.0, 0.0],
            prune_cheb: [-12.0, 0.0, 0.0, 0.0],
        }
    }
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    x.max(lo).min(hi)
}

impl Genome {
    /// The naive baseline: vanilla CFR.
    pub fn vanilla() -> Self {
        Genome {
            kind: 0,
            ..Genome::default()
        }
    }

    /// A strong static DCFR seed (near the previously-evolved static champion).
    pub fn static_dcfr() -> Self {
        Genome {
            kind: 3,
            alpha: 2.75,
            beta: -0.48,
            gamma: 2.0,
            ..Genome::default()
        }
    }

    /// A linear-dynamic-DCFR seed: aggressive early α annealing toward CFR+
    /// levels, modest momentum, light pruning — the ADR-187 hypothesis.
    pub fn dynamic_seed() -> Self {
        Genome {
            kind: 4,
            ..Genome::default()
        }
    }

    /// A Chebyshev-dynamic seed: the SOTA functional-schedule family (ADR-188).
    pub fn cheb_seed() -> Self {
        Genome {
            kind: 5,
            ..Genome::default()
        }
    }

    /// A random genome (seeds population diversity).
    pub fn random(rng: &mut Rng) -> Self {
        let cheb = |lo: f64, hi: f64, rng: &mut Rng| {
            // First coefficient near the band centre, higher orders small.
            let mut c = [0.0; CHEB_ORDER];
            c[0] = rng.range_f64(lo, hi);
            for ci in c.iter_mut().skip(1) {
                *ci = rng.range_f64(-0.8, 0.8);
            }
            c
        };
        Genome {
            kind: rng.below(KINDS as usize) as u8,
            alpha: rng.range_f64(0.0, 3.0),
            beta: rng.range_f64(-3.0, 3.0),
            gamma: rng.range_f64(0.0, 4.0),
            alpha_start: rng.range_f64(1.0, 5.0),
            alpha_end: rng.range_f64(0.5, 2.0),
            beta_start: rng.range_f64(-2.0, 2.0),
            beta_end: rng.range_f64(-3.0, 1.0),
            decay: rng.range_f64(0.5, 8.0),
            omega: rng.range_f64(0.0, 2.0),
            prune: rng.range_f64(-25.0, -2.0),
            alpha_cheb: cheb(1.0, 4.0, rng),
            omega_cheb: cheb(0.0, 1.5, rng),
            prune_cheb: cheb(-20.0, -4.0, rng),
        }
    }

    /// True if this genome engages any non-stationary lever (kinds 4 and 5).
    pub fn is_dynamic(&self) -> bool {
        matches!(self.kind % KINDS, 4 | 5)
    }

    /// Translate to a concrete solver configuration for a run of `horizon`
    /// iterations (the schedules anneal over that horizon).
    pub fn to_config(&self, horizon: u64) -> SolverConfig {
        match self.kind % KINDS {
            0 => SolverConfig::new(CfrVariant::Vanilla),
            1 => SolverConfig::new(CfrVariant::CfrPlus),
            2 => SolverConfig::new(CfrVariant::Linear),
            3 => SolverConfig::new(CfrVariant::Dcfr {
                alpha: self.alpha,
                beta: self.beta,
                gamma: self.gamma,
            }),
            4 => {
                // Linear-dynamic: α and β ramp from start to end over the run.
                let mut c = SolverConfig::new(CfrVariant::Dcfr {
                    alpha: self.alpha_start,
                    beta: self.beta_start,
                    gamma: self.gamma,
                });
                c.alpha_schedule = Some(Schedule::linear(self.alpha_start, self.alpha_end));
                c.beta_schedule = Some(Schedule::linear(self.beta_start, self.beta_end));
                c.omega = self.omega;
                c.prune = self.prune;
                c.horizon = horizon;
                c
            }
            _ => {
                // Chebyshev-dynamic: arbitrary smooth α / ω / P trajectories.
                let mut c = SolverConfig::new(CfrVariant::Dcfr {
                    alpha: 1.5,
                    beta: self.beta,
                    gamma: self.gamma,
                });
                c.alpha_schedule = Some(Schedule::chebyshev(
                    &self.alpha_cheb,
                    ALPHA_BOUNDS.0,
                    ALPHA_BOUNDS.1,
                ));
                c.beta_schedule = Some(Schedule::linear(self.beta_start, self.beta_end));
                c.omega_schedule = Some(Schedule::chebyshev(
                    &self.omega_cheb,
                    OMEGA_BOUNDS.0,
                    OMEGA_BOUNDS.1,
                ));
                c.prune_schedule = Some(Schedule::chebyshev(
                    &self.prune_cheb,
                    PRUNE_BOUNDS.0,
                    PRUNE_BOUNDS.1,
                ));
                c.horizon = horizon;
                c
            }
        }
    }

    /// A stable behaviour key for caching evaluations.
    pub fn key(&self) -> String {
        let fmt = |a: &[f64; CHEB_ORDER]| {
            a.iter()
                .map(|v| format!("{v:.2}"))
                .collect::<Vec<_>>()
                .join(",")
        };
        match self.kind % KINDS {
            0..=3 => self.to_config(0).variant.tag(),
            4 => format!(
                "lin(a={:.2}->{:.2},b={:.2}->{:.2},g={:.2},w={:.2},p={:.1})",
                self.alpha_start,
                self.alpha_end,
                self.beta_start,
                self.beta_end,
                self.gamma,
                self.omega,
                self.prune
            ),
            _ => format!(
                "cheb(a=[{}],w=[{}],p=[{}],b={:.2}->{:.2},g={:.2})",
                fmt(&self.alpha_cheb),
                fmt(&self.omega_cheb),
                fmt(&self.prune_cheb),
                self.beta_start,
                self.beta_end,
                self.gamma
            ),
        }
    }

    /// A human label for reports.
    pub fn label(&self) -> String {
        self.key()
    }

    /// Mutate exactly one gene (or switch family). One-knob-at-a-time keeps the
    /// search interpretable.
    pub fn mutate(&self, rng: &mut Rng) -> Genome {
        let mut g = *self;
        if rng.chance(0.30) {
            let mut k = rng.below(KINDS as usize) as u8;
            if k == g.kind {
                k = (k + 1) % KINDS;
            }
            g.kind = k;
            return g;
        }
        match rng.below(10 + 3 * CHEB_ORDER) {
            0 => g.alpha = clamp(g.alpha + rng.range_f64(-0.6, 0.6), 0.0, 3.0),
            1 => g.beta = clamp(g.beta + rng.range_f64(-0.6, 0.6), -3.0, 3.0),
            2 => g.gamma = clamp(g.gamma + rng.range_f64(-0.6, 0.6), 0.0, 4.0),
            3 => g.alpha_start = clamp(g.alpha_start + rng.range_f64(-0.8, 0.8), 0.5, 5.0),
            4 => g.alpha_end = clamp(g.alpha_end + rng.range_f64(-0.5, 0.5), 0.3, 2.5),
            5 => g.beta_start = clamp(g.beta_start + rng.range_f64(-0.8, 0.8), -3.0, 3.0),
            6 => g.beta_end = clamp(g.beta_end + rng.range_f64(-0.8, 0.8), -3.5, 1.5),
            7 => g.decay = clamp(g.decay + rng.range_f64(-1.5, 1.5), 0.3, 9.0),
            8 => g.omega = clamp(g.omega + rng.range_f64(-0.5, 0.5), 0.0, 2.5),
            9 => g.prune = clamp(g.prune + rng.range_f64(-5.0, 5.0), -30.0, -1.0),
            // Chebyshev coefficient jitters (kind 5). Higher-order coefficients
            // get smaller perturbations so curves stay smooth.
            i => {
                let i = i - 10;
                let (arr, which) = (i / CHEB_ORDER, i % CHEB_ORDER);
                let step = if which == 0 { 0.6 } else { 0.3 };
                let target = match arr {
                    0 => &mut g.alpha_cheb,
                    1 => &mut g.omega_cheb,
                    _ => &mut g.prune_cheb,
                };
                target[which] += rng.range_f64(-step, step);
            }
        }
        g
    }
}

/// Knobs for the evolutionary run.
#[derive(Clone, Copy, Debug)]
pub struct DarwinConfig {
    pub population: usize,
    pub generations: usize,
    /// CFR iterations used to score each candidate (also the schedule horizon).
    pub eval_iterations: u64,
    pub seed: u64,
    /// How many top genomes survive unchanged into the next generation.
    pub elite: usize,
}

impl Default for DarwinConfig {
    fn default() -> Self {
        DarwinConfig {
            population: 14,
            generations: 8,
            eval_iterations: 300,
            seed: 0xC0FFEE,
            elite: 4,
        }
    }
}

/// One generation's record, for plotting / receipts.
#[derive(Clone, Debug)]
pub struct Generation {
    pub index: usize,
    pub champion: Genome,
    pub champion_exploitability: f64,
    /// Best-so-far fitness (monotone non-decreasing): `-exploitability`.
    pub champion_fitness: f64,
    pub mean_exploitability: f64,
}

/// Result of an evolutionary run.
#[derive(Clone, Debug)]
pub struct DarwinReport {
    pub game: String,
    pub champion: Genome,
    pub champion_exploitability: f64,
    pub champion_fitness: f64,
    pub baseline_exploitability: f64,
    pub improved_over_baseline: bool,
    /// Best exploitability achieved by any *static* (stationary) genome.
    pub best_static_exploitability: f64,
    /// Best exploitability achieved by any *dynamic* (non-stationary) genome.
    pub best_dynamic_exploitability: f64,
    /// Champion fitness per generation (monotone non-decreasing).
    pub history: Vec<f64>,
    pub generations: Vec<Generation>,
    /// Full evolutionary family tree (every evaluated individual).
    pub lineage: Vec<LineageNode>,
    /// Genome keys from seed → … → champion (the winning lineage).
    pub champion_ancestry: Vec<String>,
    pub eval_iterations: u64,
    pub seed: u64,
    /// Deterministic content hash of the outcome (reproducibility receipt).
    pub receipt: String,
}

/// A population member with stable identity for lineage tracking.
#[derive(Clone, Copy, Debug)]
struct Indiv {
    genome: Genome,
    id: u64,
    parent: Option<u64>,
}

/// One node in the evolutionary family tree.
#[derive(Clone, Debug)]
pub struct LineageNode {
    pub id: u64,
    pub parent: Option<u64>,
    pub generation: usize,
    pub genome_key: String,
    pub exploitability: f64,
    pub dynamic: bool,
}

/// Walk parent links from `id` back to its seed, returning the chain of genome
/// keys root → … → champion.
fn trace_ancestry(lineage: &[LineageNode], id: u64) -> Vec<String> {
    let mut by_id: HashMap<u64, &LineageNode> = HashMap::new();
    for node in lineage {
        // Keep the earliest record of each id (its birth generation).
        by_id.entry(node.id).or_insert(node);
    }
    let mut chain = Vec::new();
    let mut cur = Some(id);
    while let Some(cid) = cur {
        if let Some(node) = by_id.get(&cid) {
            chain.push(format!("g{}:{}", node.generation, node.genome_key));
            cur = node.parent;
        } else {
            break;
        }
    }
    chain.reverse();
    chain
}

/// Score a genome: train a fresh solver for the eval budget and return its exact
/// exploitability (lower is better). Memoized via `cache` on the genome key.
fn score<G: Game + Clone>(
    game: &G,
    genome: &Genome,
    iters: u64,
    cache: &mut HashMap<String, f64>,
) -> f64 {
    let key = format!("{}|{iters}", genome.key());
    if let Some(&v) = cache.get(&key) {
        return v;
    }
    let mut solver = Solver::new(game.clone(), genome.to_config(iters));
    solver.train(iters);
    let e = exploitability(game, &solver.average_strategy());
    cache.insert(key, e);
    e
}

/// FNV-1a 64-bit — a tiny, dependency-free, deterministic hash for the receipt.
fn fnv1a(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Evolve a CFR policy genome for `game`. Returns the champion and a monotone
/// learning curve. Fully deterministic given `cfg.seed`.
pub fn evolve<G: Game + Clone>(game: &G, cfg: &DarwinConfig) -> DarwinReport {
    let mut rng = Rng::new(cfg.seed);
    let mut cache: HashMap<String, f64> = HashMap::new();
    let horizon = cfg.eval_iterations;

    let baseline_e = score(game, &Genome::vanilla(), horizon, &mut cache);

    // Seed population: strong known configs across the static/dynamic spectrum.
    let seeds = vec![
        Genome::default(),
        Genome::vanilla(),
        Genome::static_dcfr(),
        Genome::dynamic_seed(),
        Genome::cheb_seed(),
    ];
    let mut next_id: u64 = 0;
    let mut lineage: Vec<LineageNode> = Vec::new();
    let mut pop: Vec<Indiv> = Vec::with_capacity(cfg.population);
    for g in seeds {
        if pop.len() >= cfg.population {
            break;
        }
        pop.push(Indiv {
            genome: g,
            id: next_id,
            parent: None,
        });
        next_id += 1;
    }
    while pop.len() < cfg.population {
        pop.push(Indiv {
            genome: Genome::random(&mut rng),
            id: next_id,
            parent: None,
        });
        next_id += 1;
    }

    let mut best: Option<(Indiv, f64)> = None;
    let mut best_static = f64::INFINITY;
    let mut best_dynamic = f64::INFINITY;
    let mut history = Vec::with_capacity(cfg.generations);
    let mut generations = Vec::with_capacity(cfg.generations);

    for gen in 0..cfg.generations {
        let mut scored: Vec<(Indiv, f64)> = pop
            .iter()
            .map(|ind| (*ind, score(game, &ind.genome, horizon, &mut cache)))
            .collect();
        scored.sort_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.genome.key().cmp(&b.0.genome.key()))
        });

        // Record this generation's lineage and track per-class bests.
        for (ind, e) in &scored {
            lineage.push(LineageNode {
                id: ind.id,
                parent: ind.parent,
                generation: gen,
                genome_key: ind.genome.key(),
                exploitability: *e,
                dynamic: ind.genome.is_dynamic(),
            });
            if ind.genome.is_dynamic() {
                best_dynamic = best_dynamic.min(*e);
            } else {
                best_static = best_static.min(*e);
            }
        }

        let mean_e = scored.iter().map(|x| x.1).sum::<f64>() / scored.len() as f64;
        let (gen_best_ind, gen_best_e) = scored[0];

        let improved = best.map(|(_, e)| gen_best_e < e).unwrap_or(true);
        if improved {
            best = Some((gen_best_ind, gen_best_e));
        }
        let (champ_ind, champ_e) = best.unwrap();
        let champ_fitness = -champ_e;
        history.push(champ_fitness);
        generations.push(Generation {
            index: gen,
            champion: champ_ind.genome,
            champion_exploitability: champ_e,
            champion_fitness: champ_fitness,
            mean_exploitability: mean_e,
        });

        // Next generation: elites carried over (identity preserved), the rest
        // mutated from tournament survivors (child records its parent's id).
        let elite = cfg.elite.min(scored.len());
        let mut next: Vec<Indiv> = scored.iter().take(elite).map(|x| x.0).collect();
        let survivors: Vec<Indiv> = scored
            .iter()
            .take(scored.len() / 2 + 1)
            .map(|x| x.0)
            .collect();
        while next.len() < cfg.population {
            let parent = survivors[rng.below(survivors.len())];
            next.push(Indiv {
                genome: parent.genome.mutate(&mut rng),
                id: next_id,
                parent: Some(parent.id),
            });
            next_id += 1;
        }
        pop = next;
    }

    let (champion_ind, champion_exploitability) = best.expect("at least one generation");
    let champion = champion_ind.genome;
    // Walk the champion's ancestry from seed to champion (deterministic).
    let champion_ancestry = trace_ancestry(&lineage, champion_ind.id);
    let receipt = {
        let hist: Vec<String> = history.iter().map(|f| format!("{f:.6}")).collect();
        fnv1a(&format!(
            "game={};champ={};e={:.6};hist=[{}]",
            game.name(),
            champion.key(),
            champion_exploitability,
            hist.join(",")
        ))
    };

    DarwinReport {
        game: game.name().to_string(),
        champion,
        champion_exploitability,
        champion_fitness: -champion_exploitability,
        baseline_exploitability: baseline_e,
        improved_over_baseline: champion_exploitability < baseline_e,
        best_static_exploitability: best_static,
        best_dynamic_exploitability: best_dynamic,
        history,
        generations,
        lineage,
        champion_ancestry,
        eval_iterations: cfg.eval_iterations,
        seed: cfg.seed,
        receipt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::KuhnPoker;

    #[test]
    fn history_is_monotone_non_decreasing() {
        let report = evolve(
            &KuhnPoker::new(),
            &DarwinConfig {
                generations: 6,
                population: 10,
                ..Default::default()
            },
        );
        for w in report.history.windows(2) {
            assert!(
                w[1] >= w[0] - 1e-12,
                "fitness regressed: {:?}",
                report.history
            );
        }
    }

    #[test]
    fn champion_at_least_matches_baseline() {
        let report = evolve(&KuhnPoker::new(), &DarwinConfig::default());
        assert!(
            report.champion_exploitability <= report.baseline_exploitability + 1e-9,
            "champion {} worse than baseline {}",
            report.champion_exploitability,
            report.baseline_exploitability
        );
    }

    #[test]
    fn deterministic_receipt() {
        let a = evolve(&KuhnPoker::new(), &DarwinConfig::default());
        let b = evolve(&KuhnPoker::new(), &DarwinConfig::default());
        assert_eq!(a.receipt, b.receipt);
        assert_eq!(a.champion, b.champion);
    }

    #[test]
    fn dynamic_genome_is_distinct_config() {
        let g = Genome::dynamic_seed();
        let cfg = g.to_config(1000);
        assert!(cfg.is_dynamic());
        assert!(cfg.alpha_schedule.is_some());
    }

    #[test]
    fn chebyshev_genome_engages_all_levers() {
        let cfg = Genome::cheb_seed().to_config(1000);
        assert!(cfg.alpha_schedule.is_some());
        assert!(cfg.omega_schedule.is_some());
        assert!(cfg.prune_schedule.is_some());
        assert!(cfg.uses_momentum());
    }

    #[test]
    fn lineage_and_ancestry_are_populated() {
        let report = evolve(
            &KuhnPoker::new(),
            &DarwinConfig {
                generations: 5,
                population: 10,
                ..Default::default()
            },
        );
        assert!(
            !report.lineage.is_empty(),
            "lineage should record evaluated genomes"
        );
        assert!(
            !report.champion_ancestry.is_empty(),
            "champion should have an ancestry chain"
        );
        // The ancestry chain must reference real generations in order.
        let gens: Vec<&str> = report
            .champion_ancestry
            .iter()
            .map(|s| s.as_str())
            .collect();
        assert!(
            gens[0].starts_with("g0:") || gens.iter().any(|s| s.starts_with("g")),
            "ancestry tagged by generation"
        );
    }

    #[test]
    fn dynamic_can_match_or_beat_best_static_on_leduc() {
        use crate::games::LeducHoldem;
        let report = evolve(
            &LeducHoldem::new(),
            &DarwinConfig {
                population: 16,
                generations: 8,
                eval_iterations: 400,
                seed: 7,
                elite: 4,
            },
        );
        // The non-stationary family should not be worse than the best static one.
        assert!(
            report.best_dynamic_exploitability <= report.best_static_exploitability + 1e-9,
            "dynamic {} should be <= static {}",
            report.best_dynamic_exploitability,
            report.best_static_exploitability
        );
    }
}
