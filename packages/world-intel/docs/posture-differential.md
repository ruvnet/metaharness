# Strategic-posture pure-function differential evidence

Development oracle: `scripts/posture-oracle.py`, generated fixture: `tests/fixtures/posture-differential.json`, consumer: `tests/posture-differential.test.ts`.

The generator pins the SHA-256 of upstream `analysis/posture.py` at commit `fdebf9a8de6e00ed688053dd647cafedc179708b`. It extracts only `_risk_level` and the nine `_score_*` function ASTs, which were inspected as arithmetic, formatting and dict/list operations. It rejects imports, global/nonlocal statements, context managers, awaits, deletion, and unapproved calls, and evaluates with a restricted builtin dictionary. It does not import the upstream package, execute its module top level, launch the app, access credentials or invoke providers. Python is a developer fixture-generation dependency only, not a TS runtime dependency.

Reproduction from the package:

```
python3 scripts/posture-oracle.py /path/to/pinned/src/world_intel_mcp/analysis/posture.py > tests/fixtures/posture-differential.json
npm test -- --run tests/posture-differential.test.ts tests/posture.test.ts
```

## Coverage and finding

256 cases seeded with 170017 compare 2,304 domain scores and classifications plus 256 composite scores/classifications. Cases include empty observed lists, top-five selection, military activity thresholds, cable-risk thresholds, count caps, positive and negative climate deviations around ±3°C, and fractional political/shipping/Kp values. This checks numerical outputs, not all signal-string formatting. A separate 77-case matrix (11 dependencies × 7 invalid/degraded states) verifies missing, null, malformed, error, stale, nested degraded and warming data never produces a complete LOW-risk assessment.

The oracle discovered a real version-sensitive floating-point difference: case 48's weighted contributions summed naively to 57.949999999999996 (rounded 57.9), while CPython 3.12 compensated summation gives 57.95 (rounded 58.0). Native posture now uses compensated sums for country/hotspot averages and the composite, matching the recorded Python 3.12.14 oracle for all 256 cases. Upstream permits Python ≥3.11; Python 3.11 uses naive sum and can legitimately disagree at these boundaries. This implementation targets the recorded 3.12 arithmetic, not simultaneous bitwise equivalence to every supported Python version.

Missing/degraded-input handling deliberately differs from upstream's absent-field defaults: native reports UNKNOWN rather than treating unavailable evidence as zero risk. Negative nonsensical count/stress inputs remain bounded defensively; those are not advertised as exact upstream semantics. Provider integration, exhaustive JSON schemas, every signal-string formatting edge case, and live data quality are outside this oracle. The full-parity gate remains false.
