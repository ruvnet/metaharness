// SPDX-License-Identifier: MIT
//
// Darwin Mode — shared types (the integration contract).
//
// Every module in this package codes against these interfaces. They are the
// load-bearing contract: the profiler produces a RepoProfile; the generator and
// mutator produce HarnessVariants; the sandbox produces RunTraces; the scorer
// folds traces into a ScoreCard; the archive stores ArchiveRecords as a tree.
//
// See ADR-070 (loop), ADR-071 (mutation surfaces), ADR-072 (scoring),
// ADR-073 (archive), ADR-075 (acceptance).
export {};
//# sourceMappingURL=types.js.map