import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("arena_calibrate", ROOT / "scripts/calibrate.py")
c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c)


class CharacterTokenizer:
    def encode(self, text, add_special_tokens=False):
        return SimpleNamespace(ids=list(text))


class Observation:
    def __init__(self, text="OBS", done=False, reward=0):
        self.text, self.done, self.reward = text, done, reward
    def model_dump_json(self):
        return self.text


class Environment:
    def __init__(self):
        self.actions = []
    def reset(self, **kwargs):
        self.reset_kwargs = kwargs
        return Observation("RESET")
    def step(self, action):
        self.actions.append(action.model_dump())
        return Observation("OBS", action.op == "submit", 1 if action.op == "submit" else 0)


class Response:
    def __init__(self, value):self.data = json.dumps(value).encode()
    def __enter__(self):return self
    def __exit__(self, *args):return False
    def read(self, limit):return self.data[:limit]


def reply(content='{"op":"submit","answer":{}}', reason="stop", completion=30, reasoning=None):
    value = {"choices": [{"message": {"content": content}, "finish_reason": reason}]}
    if reasoning is not None:value["choices"][0]["message"]["reasoning_content"] = reasoning
    if completion is not None:
        value["usage"] = {"prompt_tokens": 100, "completion_tokens": completion, "total_tokens": 100+completion,
                          "completion_tokens_details": {"reasoning_tokens": 20}}
    return value


def args(**updates):
    values = dict(seed=1, difficulty=2, max_steps=4, max_tokens=32768, accounting="arena", request_timeout=900,
                  model="target", base_url="http://127.0.0.1:8001/v1")
    values.update(updates)
    return SimpleNamespace(**values)


def run(responses, config=None, limits=None, budget=None):
    opener = Mock()
    opener.open.side_effect = [Response(r) if isinstance(r, dict) else r for r in responses]
    env = Environment()
    row = c.run_episode(config or args(), "science_calibration", 0, "TEST_SECRET_VALUE",
                        c.TokenCounter(CharacterTokenizer(), "a"*64), budget or c.ReservationBudget(1_000_000),
                        limits or {"completion_tokens": 4096, "context_tokens": 8192}, opener,
                        env_factory=lambda: env)
    return row, opener, env


class CalibrationTests(unittest.TestCase):
    def test_thinking_switch_is_sent_and_retained_on_every_request_with_unset_omitted(self):
        digests = []
        for thinking in (None, "on", "off"):
            with self.subTest(thinking=thinking):
                row, opener, _ = run([reply('{"op":"read","path":"*"}'), reply()], args(thinking=thinking))
                expected = None if thinking is None else {"enable_thinking": thinking == "on"}
                bodies = [json.loads(call.args[0].data) for call in opener.open.call_args_list]
                self.assertEqual(len(bodies), 2)
                for body, metric in zip(bodies, row["trajectory"]["provider_metrics"]):
                    if thinking is None:
                        self.assertNotIn("chat_template_kwargs", body)
                    else:
                        self.assertEqual(body["chat_template_kwargs"], expected)
                    self.assertEqual(metric["chat_template_kwargs"], expected)
                    self.assertFalse(metric["thinking_mode_verified"])
                self.assertEqual(row["trajectory"]["chat_template_kwargs"], expected)
                self.assertEqual(row["trajectoryDigest"], c.canonical_digest(row["trajectory"]))
                digests.append(row["trajectoryDigest"])
        self.assertEqual(len(set(digests)), 3)

    def test_thinking_manifest_binds_three_distinct_modes_without_provider_calls(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(c, "provider_call") as provider, patch.dict(os.environ, {}, clear=True):
            output_path = Path(directory) / "result.jsonl"
            base = ["--base-url", "http://127.0.0.1:8001/v1", "--model", "target", "--model-revision", "revision", "--output", str(output_path)]
            digests = []
            for thinking in (None, "on", "off"):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(c.main(base + ([] if thinking is None else ["--thinking", thinking])), 0)
                plan = json.loads(output.getvalue())["plan"]
                expected = None if thinking is None else {"enable_thinking": thinking == "on"}
                self.assertEqual(plan["chat_template_kwargs"], expected)
                self.assertEqual(plan["manifest"]["chat_template_kwargs"], expected)
                self.assertFalse(plan["thinking_mode_verified"])
                self.assertIn("unverified", plan["thinking_control_scope"])
                self.assertEqual(plan["runner_sha256"], c.hashlib.sha256(Path(c.__file__).read_bytes()).hexdigest())
                self.assertEqual(plan["manifestDigest"], c.canonical_digest(plan["manifest"]))
                digests.append(plan["manifestDigest"])
            self.assertEqual(len(set(digests)), 3)
            self.assertFalse(output_path.exists())
            provider.assert_not_called()

    def test_invalid_thinking_is_rejected_before_provider_or_output(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(c, "provider_call") as provider:
            path = Path(directory) / "result.jsonl"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                c.main(["--base-url", "http://127.0.0.1:8001/v1", "--model", "target", "--model-revision", "revision",
                        "--output", str(path), "--thinking", "auto", "--execute"])
            self.assertFalse(path.exists())
            for value in (True, False, {}, "auto", "ON"):
                opener, factory = Mock(), Mock()
                with self.assertRaises(c.CalibrationError):
                    c.run_episode(args(thinking=value), "science_calibration", 0, "TEST_SECRET_VALUE", c.TokenCounter(),
                                  c.ReservationBudget(10000), {"completion_tokens": 4096, "context_tokens": 8192}, opener, factory)
                opener.open.assert_not_called()
                factory.assert_not_called()
            provider.assert_not_called()

    def test_configurable_timeout_is_forwarded_and_timeout_preserves_trajectory(self):
        row, opener, env = run([TimeoutError("TEST_SECRET_VALUE")])
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 900)
        self.assertEqual(row["failure"], "request_timeout")
        self.assertEqual(row["calls"], 1)
        self.assertGreater(len(row["trajectory"]["messages"]), 0)
        self.assertNotIn("TEST_SECRET_VALUE", json.dumps(row))
        self.assertEqual(env.actions, [])

    def test_length_failure_is_not_json_failure_and_preserves_reasoning(self):
        row, _, env = run([reply('{"op":"sub', reason="length", reasoning="unfinished reasoning")])
        self.assertEqual(row["failure"], "completion_truncated")
        assistant = row["trajectory"]["messages"][-1]
        self.assertEqual(assistant["content"], '{"op":"sub')
        self.assertEqual(assistant["reasoning_content"], "unfinished reasoning")
        self.assertEqual(env.actions, [])

    def test_reasoning_is_not_double_counted_and_native_action_is_preserved(self):
        row, _, env = run([reply(completion=30, reasoning="thinking")])
        self.assertIsNone(row["failure"])
        accounting = row["trajectory"]["accounting"]
        self.assertEqual(accounting["generation_tokens"], 30)
        self.assertEqual(accounting["post_reset_observation_tokens"], 3)
        self.assertEqual(accounting["episode_completion_tokens"], 33)
        self.assertEqual(env.actions[0]["op"], "submit")
        self.assertTrue(row["solved"])
        self.assertFalse(accounting["arena_budget_matched"])
        self.assertFalse(accounting["arena_wall_matched"])

    def test_aggregate_allowance_decrements_generation_and_observations(self):
        row, opener, env = run([reply('{"op":"read","path":"*"}', completion=10), reply(completion=10)],
                               limits={"completion_tokens": 50, "context_tokens": 8192})
        bodies = [json.loads(call.args[0].data) for call in opener.open.call_args_list]
        self.assertEqual([b["max_tokens"] for b in bodies], [50, 37])
        self.assertEqual(row["trajectory"]["accounting"]["episode_completion_tokens"], 26)
        self.assertEqual(len(env.actions), 2)
        self.assertIsNone(row["failure"])

    def test_context_exhaustion_prevents_provider_request(self):
        row, opener, _ = run([], limits={"completion_tokens": 4096, "context_tokens": 1})
        self.assertEqual(row["failure"], "episode_context_budget_exhausted")
        self.assertEqual(row["calls"], 0)
        opener.open.assert_not_called()

    def test_observation_overflow_fails_without_claiming_solved(self):
        row, _, _ = run([reply(completion=10)], limits={"completion_tokens": 11, "context_tokens": 8192})
        self.assertEqual(row["failure"], "episode_completion_budget_exceeded")
        self.assertFalse(row["solved"])

    def test_absent_usage_is_explicit_estimate(self):
        row, _, _ = run([reply(completion=None, reasoning="abc")])
        metric = row["trajectory"]["provider_metrics"][0]
        self.assertEqual(metric["generation_charged"], len('{"op":"submit","answer":{}}')+3)
        self.assertIn("estimate", metric["generation_count_method"])
        self.assertIsNone(metric["completion_tokens"])

    def test_global_reservations_bound_calls_and_timeouts_are_not_refunded(self):
        budget = c.ReservationBudget(10000)
        row, _, _ = run([TimeoutError()], budget=budget)
        reserved = budget.reserved
        self.assertGreater(reserved, 0)
        remaining = budget.remaining()
        self.assertFalse(budget.reserve(remaining, 1))
        self.assertEqual(budget.reserved, reserved)
        row2, opener, _ = run([], budget=c.ReservationBudget(1))
        self.assertEqual(row2["failure"], "global_token_budget_exhausted")
        opener.open.assert_not_called()

    def test_credential_echo_is_redacted_and_never_executed(self):
        row, _, env = run([reply('{"op":"submit","answer":{"key":"TEST_SECRET_VALUE"}}', reasoning="TEST_SECRET_VALUE")])
        self.assertEqual(row["failure"], "credential_redacted_from_provider_reply")
        self.assertNotIn("TEST_SECRET_VALUE", json.dumps(row))
        self.assertEqual(env.actions, [])

    def test_invalid_json_is_distinct_and_preserved(self):
        row, _, _ = run([reply("not json")])
        self.assertEqual(row["failure"], "invalid_json_action")
        self.assertEqual(row["trajectory"]["messages"][-1]["content"], "not json")

    def test_per_task_budget_file_and_missing_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"budgets.json"
            path.write_text(json.dumps({"tasks":[{"task_id":"math_route-d2","completion_tokens":32768,"context_tokens":32768}]}))
            config = args(episode_completion_tokens=4096, episode_context_tokens=8192, task_budgets_json=path)
            self.assertEqual(c.task_budgets(config,["math_route"])["math_route"]["completion_tokens"],32768)
            with self.assertRaises(c.CalibrationError):c.task_budgets(config,["math_route","science_calibration"])

    def test_tokenizer_pin_mismatch_fails_before_optional_import(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"tokenizer.json";path.write_text('{}')
            with self.assertRaisesRegex(c.CalibrationError,"differs"):
                c.load_counter(args(tokenizer_json=path,tokenizer_sha256='a'*64))

    def test_dryrun_documents_caps_without_credentials_or_dependencies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(c,'load_counter',side_effect=AssertionError('no load')), patch.dict(os.environ,{},clear=True):
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                result=c.main(['--base-url','http://127.0.0.1:8001/v1','--model','target','--model-revision','revision',
                               '--output',str(Path(directory)/'result.jsonl'),'--max-tokens','32768','--request-timeout','900',
                               '--max-total-tokens','500000','--accounting','arena','--tokenizer-json','local-tokenizer.json','--tokenizer-sha256','a'*64])
            plan=json.loads(output.getvalue())['plan']
            self.assertEqual(result,0)
            self.assertEqual(plan['max_tokens_per_request'],32768)
            self.assertEqual(plan['request_timeout_s'],900)
            self.assertEqual(plan['global_prompt_generation_reservation_limit'],500000)
            self.assertFalse(plan['arena_budget_matched'])
            self.assertEqual(plan['manifest']['environmentSource'],c.environment_source_binding())
            self.assertFalse((Path(directory)/'result.jsonl').exists())

    def test_execute_requires_explicit_global_ceiling(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()):
            result=c.main(['--base-url','http://127.0.0.1:8001/v1','--model','target','--model-revision','revision',
                           '--output',str(Path(directory)/'result.jsonl'),'--execute'])
            self.assertEqual(result,2)
            self.assertFalse((Path(directory)/'result.jsonl').exists())

    def test_environment_failure_still_retains_action_trajectory(self):
        opener=Mock();opener.open.return_value=Response(reply())
        env=Environment();env.step=Mock(side_effect=RuntimeError("TEST_SECRET_VALUE"))
        row=c.run_episode(args(),"science_calibration",0,"TEST_SECRET_VALUE",c.TokenCounter(CharacterTokenizer(),"a"*64),
                          c.ReservationBudget(1_000_000),{"completion_tokens":4096,"context_tokens":8192},opener,lambda:env)
        self.assertEqual(row["failure"],"environment_step_failed")
        self.assertEqual(row["trajectory"]["messages"][-1]["content"],'{"op":"submit","answer":{}}')
        self.assertNotIn("TEST_SECRET_VALUE",json.dumps(row))

    def test_provider_generation_overrun_stops_future_spend(self):
        budget=c.ReservationBudget(1_000_000)
        row, _, _=run([reply(completion=100)],limits={"completion_tokens":50,"context_tokens":8192},budget=budget)
        self.assertEqual(row["failure"],"provider_exceeded_generation_cap")
        self.assertTrue(budget.overrun)
        row2,opener,_=run([],budget=budget)
        self.assertEqual(row2["failure"],"provider_exceeded_reservation")
        opener.open.assert_not_called()

    def test_current_reasoning_field_is_preserved_and_counted_once(self):
        response=reply(completion=None)
        response["choices"][0]["message"]["reasoning"]="modern thinking"
        row, _, env=run([response])
        assistant=row["trajectory"]["messages"][-2]
        self.assertEqual(assistant["reasoning"],"modern thinking")
        self.assertNotIn("reasoning_content",assistant)
        metric=row["trajectory"]["provider_metrics"][0]
        self.assertEqual(metric["reasoning_field"],"reasoning")
        self.assertEqual(metric["generation_charged"],len('{"op":"submit","answer":{}}')+len("modern thinking"))
        self.assertEqual(env.actions[0]["op"],"submit")

    def test_identical_reasoning_aliases_coalesce_without_double_count(self):
        response=reply(completion=None,reasoning="same")
        response["choices"][0]["message"]["reasoning"]="same"
        row, _, _=run([response])
        assistant=row["trajectory"]["messages"][-2]
        self.assertEqual(assistant["reasoning"],"same")
        self.assertNotIn("reasoning_content",assistant)
        metric=row["trajectory"]["provider_metrics"][0]
        self.assertTrue(metric["reasoning_aliases_coalesced"])
        self.assertEqual(metric["generation_charged"],len('{"op":"submit","answer":{}}')+4)

    def test_conflicting_or_nontext_reasoning_aliases_fail_without_action(self):
        for modern,legacy,failure in (("modern","different","conflicting_reasoning_aliases"),
                                      (["nontext"],"legacy","invalid_reasoning_type"),
                                      ("modern",False,"invalid_reasoning_type")):
            response=reply()
            response["choices"][0]["message"].update(reasoning=modern,reasoning_content=legacy)
            row, _, env=run([response])
            self.assertEqual(row["failure"],failure)
            self.assertEqual(env.actions,[])
            self.assertFalse(row["solved"])

    def test_either_reasoning_field_redacts_credential_echo(self):
        for field in ("reasoning","reasoning_content"):
            response=reply()
            response["choices"][0]["message"][field]="TEST_SECRET_VALUE"
            row, _, env=run([response])
            self.assertEqual(row["failure"],"credential_redacted_from_provider_reply")
            self.assertNotIn("TEST_SECRET_VALUE",json.dumps(row))
            self.assertEqual(env.actions,[])

    def test_null_modern_alias_preserves_legacy_field(self):
        response=reply(reasoning="legacy reasoning")
        response["choices"][0]["message"]["reasoning"]=None
        row, _, _=run([response])
        self.assertEqual(row["trajectory"]["messages"][-2]["reasoning_content"],"legacy reasoning")
        self.assertEqual(row["trajectory"]["provider_metrics"][0]["reasoning_field"],"reasoning_content")

    def test_manifest_binds_actual_imported_environment_source_bytes(self):
        import hashlib
        binding=c.environment_source_binding()
        expected={"arena_env/tasks.py":hashlib.sha256(Path(c.task_module.__file__).read_bytes()).hexdigest(),
                  "arena_env/environment.py":hashlib.sha256(Path(sys.modules[c.ArenaEnvironment.__module__].__file__).read_bytes()).hexdigest()}
        self.assertEqual(binding["components"],expected)
        self.assertEqual(binding["sha256"],c.canonical_digest(expected))
        original={"tasks":[{"task_id":"math_route-d1","split":"train"}],"environmentSource":binding}
        changed=json.loads(json.dumps(original))
        changed["environmentSource"]["components"]["arena_env/tasks.py"]="f"*64
        changed["environmentSource"]["sha256"]=c.canonical_digest(changed["environmentSource"]["components"])
        self.assertNotEqual(c.canonical_digest(original),c.canonical_digest(changed))

    def test_redirect_is_refused(self):
        with self.assertRaises(c.CalibrationError):c.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.test')

    def test_variant_identity_reaches_reset_and_receipt_row(self):
        variant = "science_calibration-d3--sample_count_delta-m1"
        opener = Mock(); opener.open.return_value = Response(reply())
        env = Environment()
        row = c.run_episode(args(difficulty=1), variant, 0, "TEST_SECRET_VALUE",
                            c.TokenCounter(CharacterTokenizer(), "a"*64), c.ReservationBudget(1_000_000),
                            {"completion_tokens":4096,"context_tokens":8192}, opener, lambda:env)
        self.assertEqual(env.reset_kwargs["task_id"], variant)
        self.assertEqual(row["native_task_id"], variant)
        self.assertEqual(row["family"], "science_calibration")
        self.assertEqual(row["difficulty"], 3)
        self.assertEqual(row["params"], {"sample_count_delta":-1})

    def test_variant_budget_requires_exact_identity_not_family_fallback(self):
        variant = "science_calibration-d3--sample_count_delta-p1"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"budgets.json"
            config = args(episode_completion_tokens=4096,episode_context_tokens=8192,task_budgets_json=path)
            def write(task_id):
                path.write_text(json.dumps({"tasks":[{"task_id":task_id,"completion_tokens":6000,"context_tokens":8192}]}))
            write("science_calibration-d3")
            with self.assertRaises(c.CalibrationError):c.task_budgets(config,[variant])
            write(variant)
            self.assertEqual(c.task_budgets(config,[variant])[variant]["completion_tokens"],6000)
            path.write_text(json.dumps({"tasks":[{"task_id":name,"completion_tokens":6000,"context_tokens":8192}
                                                for name in ["science_calibration","science_calibration-d2"]]}))
            with self.assertRaises(c.CalibrationError):c.task_budgets(config,["science_calibration"])

    def test_native_task_validation_precedes_provider_and_output_creation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True):
            output_path = Path(directory)/"result.jsonl"
            base = ['--base-url','http://127.0.0.1:8001/v1','--model','target','--model-revision','revision',
                    '--output',str(output_path)]
            for tasks in [["science_calibration-d3--sample_count_delta-p999"],
                          ["science_calibration", "science_calibration-d2"],
                          ["science_calibration-d3--unknown-p1"]]:
                argv=base+sum((["--task-id",task] for task in tasks),[])
                with contextlib.redirect_stderr(io.StringIO()):self.assertEqual(c.main(argv),2)
                self.assertFalse(output_path.exists())
            stream=io.StringIO()
            variant="software_change-d3--suite_count_delta-p1"
            with contextlib.redirect_stdout(stream):
                self.assertEqual(c.main(base+['--task-id',variant]),0)
            self.assertEqual(json.loads(stream.getvalue())["plan"]["manifest"]["tasks"],
                             [{"task_id":variant,"split":"train"}])


if __name__=='__main__':unittest.main()
