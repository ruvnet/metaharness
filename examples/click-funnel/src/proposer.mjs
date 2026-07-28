// The Proposer — the mutation seam of the flywheel.
//
// Darwin-style: mutate ONE lever at a time, quick-score every alternative value
// on a small exploration cohort (never the holdout — the gate's data stays
// unseen), then keep the multi-objective Pareto front via @metaharness/darwin's
// `paretoFront` and take its highest-CVR member. The exploration pass is
// deliberately compliance-blind — like a growth team chasing raw conversion —
// which is exactly why the frozen promotion gate downstream matters.
import { paretoFront } from '@metaharness/darwin';
import { LEVERS, explorationCohort, simulate } from './funnel.mjs';

export function makeProposer() {
  return async (base, target) => {
    const cohort = explorationCohort(base.generation);
    const current = base.policy[target];
    const candidates = LEVERS[target]
      .filter((value) => value !== current)
      .map((value) => {
        const sim = simulate({ ...base.policy, [target]: value }, cohort);
        return { value, cvr: sim.cvr, cac: sim.cac, rpv: sim.revenuePerVisitor };
      });

    // Higher-is-better on every axis: conversion, negated cost, revenue/visitor.
    const front = paretoFront(candidates, (c) => [c.cvr, -c.cac, c.rpv]);
    front.sort((a, b) => b.cvr - a.cvr || a.value.localeCompare(b.value));
    return front[0].value;
  };
}
