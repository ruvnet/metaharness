# @metaharness/router

**Route each query to the cheapest model that's good enough.** The productized
form of the DRACO Phase-2 finding (`ruvnet/agent-harness-generator`, ADR-040):
on cross-domain research, structure/fusion does *not* beat a strong model on
quality — but routing each query to the *right, cheapest* model is a measured
Pareto win. A learned embedding router beat the best fixed model on DRACO, and
its accuracy rises monotonically with training data (the learning curve).

Dependency-free, no model files, no network. Bring any embedding model; the
router only needs the vectors.

## Install

```bash
npm install @metaharness/router
```

## Use

```ts
import { Router } from '@metaharness/router';

const router = new Router({
  qualityBar: 0.8, // cost-optimal: cheapest candidate predicted to clear 0.8
  candidates: [
    {
      id: 'anthropic/claude-haiku-4.5',
      costPerMTok: 3,
      examples: [ /* { embedding, quality } from your eval logs */ ],
    },
    {
      id: 'anthropic/claude-opus-4',
      costPerMTok: 45,
      examples: [ /* ... */ ],
    },
  ],
});

const pick = router.route(queryEmbedding);
// → { id, predictedQuality, costPerMTok, metBar }
```

For each candidate the router predicts quality on the new query via k-NN over
that candidate's labelled `examples` (query embedding → quality it achieved),
then returns the **cheapest candidate predicted to clear `qualityBar`** (or the
best-predicted if none clear it / no bar is set). Feed it your own eval logs;
the more examples, the closer it gets to the per-query oracle (DRACO's learning
curve was still rising at n=19).

## Why this and not "a bigger model" / "more structure"

DRACO measured it honestly: structure degrades quality, and a cheap model
matches frontier quality at ~10× lower cost. The leverage is **choosing** the
model, not wrapping it. This is that choice as a library.

MIT.
