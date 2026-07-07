# ADR-238: @metaharness/workspace-lens — Jacobian-Lens interpretability primitive (IntOps)

- **Status**: Accepted — runtime measurement core shipped ($0, synthetic-tested). Lens FITTING is external (open-weight model + backward pass); this package APPLIES a fitted lens.
- **Date**: 2026-07-07
- **Deciders**: ruv
- **Tags**: interpretability, jacobian-lens, global-workspace, ai-safety, intops, mechanistic-governance, metaharness, open-weight
- **Relates-to**: Anthropic, "Verbalizable Representations Form a Global Workspace in Language Models" (2026-07-06) + reference code `anthropics/jacobian-lens`; ADR-197 (redblue adversarial), ADR-234 (recover-not-create ceiling — this gives it an *internal-process* probe)
- **Artifacts**: `packages/workspace-lens/src/{linalg,types,lens,safety,drift,receipt,decision,index}.ts`, `packages/workspace-lens/__tests__/workspace-lens.test.ts`, `packages/workspace-lens/README.md`

---

## 1. Context

Classic **logit lens** decodes an intermediate activation through the unembedding directly, assuming
middle layers already live in final-output coordinates — they don't, so the readout is noisy. The
**Jacobian Lens** learns an average layer→final map `J_l` and decodes `lens_l(h) = unembed(J_l · h)`,
surfacing the concepts an activation is *disposed* to produce later — earlier in the network, often
before the first output token. The paper shows LLMs maintain a small set of verbalizable representations
that behave like a functional **global workspace**, and that hidden concepts (evaluation awareness,
manipulation, "secretly", "trick") appear there even when absent from the output.

We want this as **interpretability infrastructure**, not a research artifact: a diagnostic + governance
probe for open-weight models — "Interpretability Operations (IntOps)".

## 2. Decision

Ship `@metaharness/workspace-lens` as a **runtime measurement primitive**:

- **Runtime-only.** The package *applies* a fitted lens; it never fits one (fitting needs the model's
  backward pass — open-weight + GPU, external). Inference-time projection is `J_l · h` + a softmax:
  static linear algebra, **zero** backward passes → cheap enough for per-request governance, not just
  1% shadow sampling.
- **Model-agnostic + dependency-free.** A `LensArtifact` carries the vocab + unembedding, so scoring
  never touches a tokenizer at runtime. Pure TS over `number[]` (node built-ins only), deterministic.
- **Concept-direction safety, not token strings.** Cross-family vocabulary alignment (Qwen vs. Gemma) is
  solved at the concept-direction level: a canonical concept name → a per-model unit vector in J-space
  (`ConceptVector`), matched by cosine, never cross-applied across `modelId`.
- **Signable receipt + decision rule.** `buildReceipt` emits the causal trajectory (where a concept
  arrived, drift, entropy, competing objectives); `decide` = `taskResolved && drift<θ &&
  noCriticalFlags && receiptCoverage===1`. Correctness first, cost second, receipts always.

## 3. Consequences

- MetaHarness gains a `workspace_probe` surface (does a harness make the model hold better intermediate
  concepts?), Darwin-Mode **mutation evidence** (reject a mutation that improves the final token but loses
  the workspace's early grip — structurally brittle), and a runtime **circuit-breaker** for tool-call /
  PII / untrusted-retrieval paths (a spike in exfiltration/override directions can halt mid-forward-pass).
- **Honest framing (kept):** a measurement primitive, **not** a consciousness claim — the paper frames
  the workspace connection as *functional*. The practical claim (a measurable window into hidden
  reasoning) is enough. Fitting a lens is out of scope here and requires open-weight access.

## 4. Acceptance test

Fit a lens on a 1.5B–7B Qwen model; on silent-state-holding prompts (*"Is 12+5=1 correct? Yes/No"*),
verify the Jacobian readout surfaces the abstract judgment ("wrong"/"incorrect") in mid-layers 2–3 layers
earlier and ≥20% clearer than logit-lens, before the first output token, across ≥50 variations. The test
suite ships the **mechanism shape** of this on synthetic artifacts ($0, no model).
