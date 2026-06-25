# SPDX-License-Identifier: MIT
# Faithful thin wrapper around lcb_runner.runner.custom_evaluator.main():
#   - loads the OFFICIAL windowed benchmark (build_prompt_benchmark)
#   - FILTERS it to exactly the question_ids present in --custom_output_file (a strict SUBSET of the window)
#   - runs the OFFICIAL scorer (codegen_metrics) untouched
# This is selection-of-which-problems-to-score, NOT a reimplemented scorer. The execution of generated
# code against hidden public+private tests is 100% the official codegen_metrics path.
#
# Why needed: custom_evaluator asserts len(outputs)==len(benchmark). Our n=25 is a balanced SUBSET of the
# 56-problem >=2024-12-01 window, so we align the benchmark to our 25 by question_id before scoring.
#
# Run (cwd = ~/LiveCodeBench, venv active):
#   PYTHONPATH=~/LiveCodeBench python eval-subset.py --custom_output_file lcb-out.json \
#     --release_version release_v5 --start_date 2024-12-01 --num_process_evaluate 4 --timeout 6
import json
from lcb_runner.runner.parser import get_args
from lcb_runner.utils.scenarios import Scenario
from lcb_runner.evaluation import extract_instance_results
from lcb_runner.runner.scenario_router import (
    build_prompt_benchmark,
    sort_and_extract_save_results,
    get_metrics,
)


def main():
    args = get_args()
    assert args.scenario == Scenario.codegeneration, "this wrapper is codegeneration-only"

    benchmark, _ = build_prompt_benchmark(args)

    with open(args.custom_output_file, "r") as f:
        custom_outputs = json.load(f)
    assert isinstance(custom_outputs, list) and isinstance(custom_outputs[0], dict)

    # The subset of question_ids we actually generated for.
    out_by_qid = {str(o["question_id"]): o["code_list"] for o in custom_outputs}
    wanted = set(out_by_qid)

    # Filter the official benchmark to exactly our subset (must be a strict subset of the window).
    benchmark = [b for b in benchmark if str(b.question_id) in wanted]
    got_qids = {str(b.question_id) for b in benchmark}
    missing = wanted - got_qids
    assert not missing, f"output question_ids not found in benchmark window: {sorted(missing)}"
    assert len(benchmark) == len(custom_outputs), f"{len(benchmark)} != {len(custom_outputs)}"

    # Align code_list to the sorted benchmark order (same sort key custom_evaluator uses).
    custom_outputs = [
        out_by_qid[str(qid)]
        for qid in sorted(wanted)
    ]
    benchmark = sorted(benchmark, key=lambda b: str(b.question_id))

    save_results = [
        instance.insert_output(custom_output, custom_output)
        for instance, custom_output in zip(benchmark, custom_outputs)
    ]
    save_results, combined_results = sort_and_extract_save_results(args.scenario, save_results)

    metrics = get_metrics(args.scenario, args, benchmark, combined_results)
    graded = extract_instance_results(metrics[1])

    metadatas = metrics[2]
    save_eval_results = [
        instance.insert_output_evaluation(outputs_list, extracted_list, graded_list, metadata=meta)
        for instance, (outputs_list, extracted_list), graded_list, meta in zip(
            benchmark, combined_results, graded, metadatas
        )
    ]

    out_path = args.custom_output_file[:-5] + "_codegeneration_output.json"
    with open(out_path, "w") as f:
        json.dump(save_results, f, indent=2)
    with open(out_path.replace(".json", "_eval.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    with open(out_path.replace(".json", "_eval_all.json"), "w") as f:
        json.dump(save_eval_results, f, indent=2)

    # metrics[0] is the aggregate dict from codegen_metrics (pass@1 etc.)
    print("=== LCB SUBSET EVAL (official codegen_metrics) ===")
    print("n:", len(benchmark))
    print("aggregate:", json.dumps(metrics[0], indent=2))
    n_pass = sum(1 for g in graded if g and g[0] is True)
    print(f"pass@1: {n_pass}/{len(benchmark)} = {n_pass/len(benchmark):.4f}")
    # per-problem
    for inst, g in zip(benchmark, graded):
        print(f"  {inst.question_id} {inst.platform.value}/{inst.difficulty.value}: {'PASS' if (g and g[0]) else 'FAIL'}")


if __name__ == "__main__":
    main()
