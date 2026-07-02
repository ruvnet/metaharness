# ⚠️ DEPRECATED — this is a STALE MIRROR. Do not build here.

The **live, deployed** Cognitum completions gateway is a **separate repository**:

> ## → `cognitum-one/meta-llm`  (`/home/ruvultra/projects/meta-llm`)

That repo is the source of truth: it carries the ADR-227 Intervention Flywheel,
the ADR-224 P1 streaming-billing fix, the ADR-225 GLM→Sonnet→Fable tier ladder,
the ADR-231 MidStream in-flight plane, `src/cache/`, `src/midstream/`, and is
deployed to Cloud Run (rev `apicompletions-00071`+).

**This `services/apicompletions/` directory is the original ADR-203 scaffold,
frozen before the split.** It has NO flywheel, NO tier ladder, NO cache/midstream
planes. Any new gateway work committed here targets the WRONG copy and will not
reach production.

## If you are an agent or a future session
- Gateway / meta-llm / apicompletions work → `cd /home/ruvultra/projects/meta-llm`
  (`cognitum-one/meta-llm`), NOT a metaharness worktree.
- Verify: `git remote get-url origin` → `cognitum-one/meta-llm`, and
  `git ls-tree HEAD src/flywheel` must be non-empty.
- meta-llm ADRs live in `docs/adr/` (singular); metaharness ADRs in `docs/adrs/`.

This mirror is retained only for git-history reference. Do not extend it.
