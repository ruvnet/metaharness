# Bounded environment evolution interface

The Darwin driver lives in the coordinating `integrations/openenv-arena-darwin` lane. This directory exposes actual generator controls; it does not run a second search or grant submission authority.

Obtain the registry from the same checkout used by the calibration runner:

```sh
python -m arena_env.knobs --json
```

| Family | Knob | Integer bounds | Default | Maximum generated dimension |
| --- | --- | --- | --- | --- |
| software_change | suite_count_delta | -1 to 2 | 0 | 12 regression suites, 4096 possible subsets |
| science_calibration | sample_count_delta | -2 to 2 | 0 | 12 samples |

Import `KNOBS`, `parse_task_id` and `format_task_id` from `arena_env.knobs`. `parse_task_id(value)` returns `(family, difficulty, params)`. `format_task_id(family, difficulty=2, params=None)` returns the canonical native ID. `make_task(family, seed, difficulty=2, params=None)` applies the validated setting. Unknown parameters, booleans, floats, multiple knobs and values outside the bounds fail before generation.

IDs use `<family>-d<1|2|3>--<knob>-p<magnitude>` for positive values and `-m<magnitude>` for negative values. Examples:

```text
software_change-d3--suite_count_delta-p1
science_calibration-d3--sample_count_delta-m2
```

Default zero values are omitted. Explicit p0/m0, leading zeros and repeated suffixes reject. Legacy bare family IDs still mean difficulty 2 at native reset. In the calibration CLI a bare family uses `--difficulty`; an explicit native ID retains the difficulty encoded in that ID. Exact native IDs are used for reset, manifest and per task budget matching. The episode row preserves the requested `task_id` and adds `native_task_id`, `family` and `params` so old bare-family consumers can migrate without ambiguity.

The random seed namespace and stream are unchanged. At the original knob release `0af81c5`, omitted, empty and zero parameter maps reproduced all 768 frozen v2 reference task objects byte for byte. The later science clarification adds exactly one prompt sentence requiring medians for every sample, including quarantined samples. The regression check permits only that documented sentence; all remaining task bytes, input data, expected answers and verifier behavior remain constrained to the original fixtures. Nondefault variants report generator version 3 and parameters in internal generation metadata. Public observations expose the task family and source files, not oracle answers. The same verifier and protocol grade all variants. Token budgets are separate runner/request metadata; they cannot be set as generator parameters.

Validation at implementation: 140 Python tests and 782 subtests passed. An actual local native server passed 16 WebSocket episodes at the four maximum difficulty boundary IDs, including examples, independent public-file oracles, wrong answers and seeded replay. These controls establish behavior, not model fitness. See `evidence/native-knob-replay-local.json`. A new container digest still needs separate publication and anonymous qualification before any variant is submitted.

Calibration runner accepts the canonical ID through `--task-id`. A repeated family alias resolving to the same native ID rejects. A task budget file must cover each exact selected native ID; a base family's budget cannot silently substitute for a variant. Dry runs make no model calls. Real execution retains the existing explicit token reservation ceiling, source binding and credential handling.

Candidate fitness and submission readiness require the separate [review contract](orchestration/READINESS-REVIEW.md). Control tests, a generated variant or a successful model call do not authorize promotion or submission.
