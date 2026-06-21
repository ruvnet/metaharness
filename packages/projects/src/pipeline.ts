// SPDX-License-Identifier: MIT
//
// @metaharness/projects — pipeline.ts (end-to-end discovery PIPELINE).
//
// Composes the existing modules into one resumable, cost-attributed discovery
// run over many targets:
//   router.classify  — pick a lane (cheap/frontier) per target from its TaskSignal
//   discovery.runDiscovery — verify weaknesses for the target (injected lanes)
//   trace.Tracer + CostLedger — emit one span per target, attribute its cost
//   checkpoints.CheckpointStore — durably record each completed target so a
//     re-run with the SAME store SKIPS already-finished targets (resume) and
//     reuses their persisted findings/cost without re-invoking the lanes.
//
// Pure + deterministic given deterministic lanes: no Date.now, no RNG, stable
// iteration order. The real LLM/exec wiring lives in bin/darwin-discover.mjs.

import type { CodeTarget, DiscoveryLanes, VerifiedFinding } from './discovery.js';
import { runDiscovery } from './discovery.js';
import type { Lane, RouterPolicy, TaskSignal } from './router.js';
import { classify } from './router.js';
import type { Checkpoint } from './checkpoints.js';
import { CheckpointStore } from './checkpoints.js';
import { CostLedger, Tracer } from './trace.js';
import { hashJson } from './core.js';

/** One unit of work for the pipeline: a code target plus an optional routing signal. */
export interface PipelineTarget {
  id: string;
  target: CodeTarget;
  /** If present, classify() picks the lane recorded for this target. */
  signal?: TaskSignal;
}

/** Per-target outcome in the aggregated pipeline result. */
export interface PipelineTargetResult {
  id: string;
  lane: Lane;
  findings: VerifiedFinding[];
  verified: number;
  costUnits: number;
  /** True when this target was served from a prior checkpoint (resume), not re-run. */
  resumed: boolean;
}

/** The aggregated result of a full pipeline run. */
export interface PipelineResult {
  perTarget: PipelineTargetResult[];
  totalVerified: number;
  totalCostUnits: number;
  /** Cost-units grouped by span kind (from the CostLedger). */
  ledgerByKind: Record<string, number>;
  /** Number of targets durably checkpointed (one per target). */
  checkpoints: number;
}

/** The fixed run id under which the pipeline persists its per-target checkpoints. */
const PIPELINE_RUN_ID = 'discovery-pipeline';

/** The shape of the per-target state we persist in a checkpoint (resume payload). */
interface CheckpointState {
  id: string;
  lane: Lane;
  findings: VerifiedFinding[];
  verified: number;
  costUnits: number;
}

/**
 * Run the end-to-end discovery pipeline over `targets`.
 *
 * For each target, in order:
 *  1. If `signal` is present, classify it (with `opts.routerPolicy`) to pick the
 *     lane recorded on the result; otherwise the lane defaults to 'cheap'.
 *  2. If a checkpoint for this target already exists in `opts.store`, SKIP the
 *     discovery + cost work and reuse the persisted findings/cost (resumed:true).
 *     A re-run with the SAME store therefore never re-invokes the lanes.
 *  3. Otherwise run runDiscovery(target, lanes), emit one Tracer span (kind
 *     'mutation' for the frontier lane, 'tool' for the cheap lane) carrying the
 *     run's costUnits, add it to the CostLedger, and durably checkpoint the result.
 *
 * Totals + ledgerByKind are aggregated from the CostLedger. Deterministic given
 * deterministic lanes.
 */
export async function runDiscoveryPipeline(
  targets: PipelineTarget[],
  lanes: DiscoveryLanes,
  opts: { store?: CheckpointStore; routerPolicy?: RouterPolicy } = {},
): Promise<PipelineResult> {
  const store = opts.store ?? new CheckpointStore();
  const ledger = new CostLedger();
  const tracer = new Tracer(PIPELINE_RUN_ID);

  // Index the persisted checkpoints by target id so a re-run can skip + reuse them.
  const persisted = new Map<string, Checkpoint>();
  for (const cp of store.load(PIPELINE_RUN_ID)) {
    persisted.set((cp.state as CheckpointState).id, cp);
  }

  const perTarget: PipelineTargetResult[] = [];

  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    const lane: Lane = t.signal ? classify(t.signal, opts.routerPolicy).lane : 'cheap';

    const prior = persisted.get(t.id);
    if (prior) {
      // Resume: reuse the checkpointed findings/cost. The lanes are NOT invoked.
      const st = prior.state as CheckpointState;
      ledger.add(
        tracer.span(prior.toolCalls > 0 ? 'tool' : 'mutation', `discover:${t.id}`, {
          costUnits: st.costUnits,
          outcome: 'skipped',
        }),
      );
      perTarget.push({
        id: t.id,
        lane: st.lane,
        findings: st.findings,
        verified: st.verified,
        costUnits: st.costUnits,
        resumed: true,
      });
      continue;
    }

    // Fresh work: run discovery, attribute its cost to a span + the ledger.
    const result = await runDiscovery(t.target, lanes);
    const kind = lane === 'frontier' ? 'mutation' : 'tool';
    ledger.add(tracer.span(kind, `discover:${t.id}`, { costUnits: result.costUnits }));

    const state: CheckpointState = {
      id: t.id,
      lane,
      findings: result.findings,
      verified: result.verified,
      costUnits: result.costUnits,
    };
    const cp: Checkpoint = {
      runId: PIPELINE_RUN_ID,
      step: i,
      genomeId: t.id,
      state,
      stepResult: { verified: result.verified, costUnits: result.costUnits },
      modelCalls: 0,
      // Record the lane on the checkpoint so a resume re-derives the same span kind.
      toolCalls: kind === 'tool' ? 1 : 0,
      costUnits: result.costUnits,
      fitness: result.verified,
      hash: hashJson(state),
    };
    store.save(cp);
    persisted.set(t.id, cp);

    perTarget.push({
      id: t.id,
      lane,
      findings: result.findings,
      verified: result.verified,
      costUnits: result.costUnits,
      resumed: false,
    });
  }

  return {
    perTarget,
    totalVerified: perTarget.reduce((acc, r) => acc + r.verified, 0),
    totalCostUnits: ledger.total(),
    ledgerByKind: ledger.byKind(),
    checkpoints: store.load(PIPELINE_RUN_ID).length,
  };
}
