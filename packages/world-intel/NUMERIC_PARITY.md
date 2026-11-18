# Falsifiable numeric and sampling validation

Reference: pinned World Intel commit
fdebf9a8de6e00ed688053dd647cafedc179708b. Fixtures are generated once from its
standard-library Python functions, then consumed by TypeScript tests. No Python
bridge is shipped or required by tests. No new model assets or providers were
used for this extension.

`extended-numeric-golden.json` contains:
- Four seeded 80-point correlation datasets: nearly perfect positive/negative,
  large-offset values, and independent noise.
- All 16 Student-t and eight incomplete-beta reference cases from upstream's
  documented SciPy 1.18.1/NumPy 2.5.4 oracle. Student-t values use relative
  tolerance 1e-9, including probabilities around 1e-66, so zero cannot falsely
  satisfy an absolute-only tolerance.
- 335 history rows with missing days, later revisions, undated and coarse period
  observations. Six day/week/month by levels/changes cases compare complete
  series descriptions, pair results and tested/significant counts against pinned
  upstream output. This checks latest-vintage selection, last-observation period
  sampling, uneven intervals, gaps and explicit date windows.

`history-date-golden.json` contains 26 pinned-Python results covering valid and
invalid leap days, UTC offset year rollovers, subsecond truncation, naive clocks,
Unicode digits, null/boolean inputs and invalid clock values.

Vector tests independently check Python-compatible content hashes/point IDs,
microsecond timestamps, astral-codepoint lengths, inclusive cutoffs, hours=0,
negative cosine scores, missing-provider/invalid-limit/closed-store errors and
near-tie sorting before score rounding. A near-tie pair rounds to equal displayed
scores but still sorts by the unrounded cosine, rather than insertion order.

## Remaining limits

Qdrant does not specify a tie-break ordering in the pinned calls. SQLite chooses
a deterministic timestamp/ID ordering for exactly equal similarities; identical
Qdrant tie ordering is not claimed. Floating-point runtime differences can change
rankings when score margins are tiny. The actual BGE six-fixture tolerance and
ranking evidence is documented separately in LOCAL_EMBEDDINGS.md.

The native archive is an exact bounded scan, not Qdrant's indexing backend.
Extreme numeric JSON spellings, scientific-notation timestamp identities and
all possible embedding inputs are not proven equivalent. These tests support
specific contracts and numerical tolerances, not a blanket 100% parity claim.
