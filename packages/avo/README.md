# `@metaharness/avo`

Governed autonomous variation for real repositories and evaluator suites.

The AVO package exports an autonomous variation API and versioned evidence schemas.

The model chooses repeated inspect, search, hypothesis, edit, execute, evaluate,
repair/revert, branch, memory, and commit actions. MetaHarness retains immutable
authority over capabilities, budgets, protected invariants, promotion,
quarantine, rollback, and signed receipts.

```ts
import { GovernedVariationOperator } from '@metaharness/avo';

const result = await new GovernedVariationOperator({
  // Inject a model/host agent, bounded repository adapter, evaluator suite,
  // capability policy, approval gate, RVF memory, supervisor, signer,
  // checkpoint store, budgets, and protected invariants.
}).run();
```

Production memory uses the optional `agenticow` peer over RVF. Install it when
using `RvfGovernedMemory`:

```bash
npm install @metaharness/avo agenticow
```

The initially evolvable surfaces are retrieval policy, model routing, context
policy, test policy, and repair strategy. Security policy and capability
expansion are not evolvable surfaces.

`DarwinVariationAdapter` is the versioned, structural bridge to Darwin's
opt-in `EvolutionConfig.variationOperator`. When present it replaces the
one-call `CodeGenerator` child path; the outer Darwin loop still evaluates,
archives, promotes, budgets, and rolls back the returned candidate.

## Proofs

```bash
npm run build
npm test
npm run benchmark:swebench
```

The test suite includes a real RVF run killed and restored at actions 100 and
200, requiring identical signed receipts, state hash, evaluator evidence,
lineage, and winner. The default benchmark data is a synthetic mechanism fixture
and cannot authorize an AVO-class product claim. Supply preregistered observations
with `SWE_BENCH_RESULTS=/path/results.json` for the 100-task ship gate.

`npm run claims:avo` verifies the governed release surfaces. Performance and
frontier claims fail closed unless an exact-tag-SHA evidence bundle binds the
exact npm tarball, preregistered predicate, measured costs, complete lineage
roots, and two official grader receipts from distinct pinned organizations. The trust policy
digest must come from the protected `AVO_CLAIM_TRUST_POLICY_HASH` release
variable; a key embedded only in the bundle is never trusted.

See [ADR-251](../../docs/adrs/ADR-251-governed-autonomous-variation-runtime.md)
and [ADR-253](../../docs/adrs/ADR-253-avo-release-claim-evidence-gate.md).
