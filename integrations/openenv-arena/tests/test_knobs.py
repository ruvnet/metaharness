"""Native bounded generator knobs; fixtures do not claim model improvement."""
import copy
import hashlib
import json

import pytest

from arena_env.environment import ArenaEnvironment, ArenaAction
from arena_env.tasks import (
    KNOBS, TASK_IDS, format_task_id, grade, make_task, oracle_answer,
    parse_task_id, validate_task_params,
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def test_768_version2_baseline_tasks_only_change_documented_science_prompt():
    # Frozen before any knob implementation, over complete task objects rather
    # than only source files. Every original family, difficulty and 32 seeds.
    before = "69d6a24dc601ad5bb914d846b34b8d784a2d44b037530220c553975d901c4ffd"
    records = {}
    for family in TASK_IDS:
        for seed in range(32):
            for difficulty in (1, 2, 3):
                task = make_task(family, seed, difficulty)
                legacy = copy.deepcopy(task)
                if family == "science_calibration":
                    clarification = "The medians map must include every sample, including quarantined samples. "
                    assert legacy["prompt"].count(clarification) == 1
                    legacy["prompt"] = legacy["prompt"].replace(clarification, "", 1)
                records[f"{family}/{seed}/{difficulty}"] = digest(legacy)
                assert make_task(family, seed, difficulty, {}) == task
                for knob, spec in KNOBS.get(family, {}).items():
                    assert make_task(family, seed, difficulty, {knob: spec["default"]}) == task
    assert digest(records) == before


def test_bounded_knob_instances_have_independent_correct_oracles():
    for family, knobs in KNOBS.items():
        for knob, spec in knobs.items():
            for value in range(spec["min"], spec["max"] + 1):
                for difficulty in (1, 2, 3):
                    for seed in range(32):
                        params = {knob: value}
                        original = copy.deepcopy(params)
                        task = make_task(family, seed, difficulty, params)
                        assert params == original
                        assert oracle_answer(task) == task["expected"]
                        assert grade(task, oracle_answer(task)) == 1
                        assert grade(task, {}) == 0
                        assert sum(len(v.encode()) for v in task["files"].values()) < 4096
                        assert len(task["files"]) == 3
                        if value:
                            assert task["generator_version"] == 3
                            assert task["params"] == params
                        else:
                            assert task["generator_version"] == 2
                            assert "params" not in task
                        if family == "software_change":
                            suites = json.loads(task["files"]["tests.json"])
                            assert len(suites) == 7 + difficulty + value
                            assert len(suites) <= 12  # At most 4096 subsets.
                        else:
                            samples = json.loads(task["files"]["samples.json"])
                            assert len(samples) == 4 + 2 * difficulty + value
                            assert 4 <= len(samples) <= 12


def test_native_id_roundtrips_and_default_normalization():
    for family in TASK_IDS:
        assert parse_task_id(family) == (family, 2, {})
        for difficulty in (1, 2, 3):
            assert format_task_id(family, difficulty) == f"{family}-d{difficulty}"
            assert parse_task_id(format_task_id(family, difficulty)) == (family, difficulty, {})
            for knob, spec in KNOBS.get(family, {}).items():
                for value in range(spec["min"], spec["max"] + 1):
                    params = {knob: value}
                    encoded = format_task_id(family, difficulty, params)
                    assert parse_task_id(encoded) == (family, difficulty, params if value else {})
                    assert format_task_id(*parse_task_id(encoded)) == encoded
    assert format_task_id("software_change", 2, {"suite_count_delta": 1}) == "software_change-d2--suite_count_delta-p1"
    assert format_task_id("science_calibration", 3, {"sample_count_delta": -2}) == "science_calibration-d3--sample_count_delta-m2"


@pytest.mark.parametrize("task_id", [
    None, True, 3, [], "unknown-d2", "software_change-d4", "software_change-d02",
    "software_change--suite_count_delta-p1", "software_change-d2--suite_count_delta-p0",
    "software_change-d2--suite_count_delta-m0", "software_change-d2--suite_count_delta-p01",
    "software_change-d2--suite_count_delta-m2", "science_calibration-d2--sample_count_delta-p3",
    "software_change-d2--suite_count_delta-1", "software_change-d2--suite_count_delta-+1",
    "software_change-d2--suite_count_delta-p1--suite_count_delta-p2",
    "software_change-d2--sample_count_delta-p1", "math_route-d2--suite_count_delta-p1",
    "science_calibration-d2--verifier-p1", "../science_calibration-d2", "x" * 129,
])
def test_invalid_native_ids_and_reset_are_rejected(task_id):
    with pytest.raises(ValueError):
        parse_task_id(task_id)
    with pytest.raises(ValueError):
        ArenaEnvironment().reset(task_id=task_id, seed=1)


@pytest.mark.parametrize("params", [
    True, [], 1, "suite_count_delta=1", {"suite_count_delta": True}, {"suite_count_delta": 1.0},
    {"suite_count_delta": "1"}, {"suite_count_delta": float("nan")}, {"suite_count_delta": float("inf")},
    {"suite_count_delta": -2}, {"suite_count_delta": 3}, {"grader": 0}, {1: 0},
    {"suite_count_delta": 1, "faults": 1},
])
def test_invalid_params_fail_without_coercion(params):
    with pytest.raises(ValueError):
        validate_task_params("software_change", params)
    with pytest.raises(ValueError):
        make_task("software_change", 1, 2, params)
    with pytest.raises(ValueError):
        format_task_id("software_change", 2, params)


@pytest.mark.parametrize("family,params", [
    ("software_change", {"suite_count_delta": -1}),
    ("software_change", {"suite_count_delta": 2}),
    ("science_calibration", {"sample_count_delta": -2}),
    ("science_calibration", {"sample_count_delta": 2}),
])
def test_native_reset_reaches_the_exact_requested_variant(family, params):
    env = ArenaEnvironment()
    task_id = format_task_id(family, 3, params)
    reset = env.reset(task_id=task_id, seed=7)
    task = make_task(family, 7, 3, params)
    assert reset.task_id == family and not reset.done
    files = env.step(ArenaAction(op="read", path="*"))
    assert json.loads(files.content) == task["files"]
    # Independent solver receives only public source, not params or expected.
    answer = oracle_answer({"task_id": reset.task_id, "files": json.loads(files.content)})
    result = env.step(ArenaAction(op="submit", answer=answer))
    assert result.done and result.reward == 1


def test_rejected_reset_preserves_existing_episode_and_registry():
    registry = copy.deepcopy(KNOBS)
    env = ArenaEnvironment()
    env.reset(task_id="science_calibration-d2", seed=9)
    with pytest.raises(ValueError):
        env.reset(task_id="science_calibration-d2--sample_count_delta-p999", seed=9)
    result = env.step(ArenaAction(op="read", path="*"))
    assert json.loads(result.content) == make_task("science_calibration", 9, 2)["files"]
    assert KNOBS == registry
