# @metaharness/autogenous

MetaHarness adapter for [`ruvnet/autogenous`](https://github.com/ruvnet/autogenous), initially targeting the governed `packages/radio-moe` policy surface.

It does not copy Autogenous or replace its in-repo flywheel. It connects Autogenous' real benchmark to `@metaharness/flywheel` while preserving the source project's removability contract.

## Frozen versus evolvable

Evolvable: `sameProvider`, `sameArch`, `sameSize`, `sourceJaccard`, and `quorumThreshold`, each clamped to Autogenous' constitutional ceilings.

Frozen: `sameAccuracyBand` until it has a dedicated benchmark; source and fusion algorithms; signature, replay, and sequence checks; fail-closed behavior; hard gates and promotion authority.

Promotion is the Autogenous predicate:

```text
Better AND Safe AND Authorized AND Reversible
```

Correlated-error and independent-error quality must also avoid regression. A benchmark runner must be injected so this adapter scores the real Autogenous implementation rather than a duplicate simulation.

## Usage

```ts
import { runFlywheelGenerations, makeSigner } from '@metaharness/flywheel';
import {
  AUTOGENOUS_MUTATION_TARGETS,
  autogenousPromotionRule,
  genomeToPolicy,
  makeAutogenousEvaluator,
  makeAutogenousProposer,
  rootGenome,
} from '@metaharness/autogenous';

const evaluator = makeAutogenousEvaluator(async (genome, suite) => {
  // Call radio-moe's own evaluate()/bench:fusion adapter here.
  return runRadioMoeBench(genome, suite);
});

await runFlywheelGenerations({
  rootPolicy: genomeToPolicy(rootGenome()),
  mutationTargets: [...AUTOGENOUS_MUTATION_TARGETS],
  proposer: makeAutogenousProposer(),
  evaluator,
  promotionRule: autogenousPromotionRule,
  holdout: { id: 'radio-moe-holdout', items: [] },
  maxGenerations: 20,
  signer: makeSigner(),
  dataSource: 'AUTOGENOUS_RADIO_MOE',
});
```

The benchmark seam is deliberately explicit: the adapter never trusts caller-supplied `promote` booleans and never reimplements radio-moe's safety-critical calculations.
