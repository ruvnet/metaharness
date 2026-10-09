import json
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from arena_env.app import app
from arena_env.environment import ArenaEnvironment, ArenaAction, MAX_STEPS
from arena_env.tasks import TASK_IDS, make_task, oracle_answer


@pytest.mark.parametrize("task_id", TASK_IDS)
@pytest.mark.parametrize("difficulty", [1, 2, 3])
def test_oracle_and_empty(task_id, difficulty):
    env = ArenaEnvironment()
    reset = env.reset(task_id=f"{task_id}-d{difficulty}", seed=23)
    assert not reset.done and reset.reward == 0
    data = env.step(ArenaAction(op="read", path="*"))
    assert json.loads(data.content) == make_task(task_id, 23, difficulty)["files"]
    expected = oracle_answer(make_task(task_id, 23, difficulty))
    end = env.step(ArenaAction(op="submit", answer=expected))
    assert end.done and end.reward == 1
    assert env.step(ArenaAction(op="submit", answer={})).reward == 1
    env.reset(task_id=task_id, seed=23)
    assert env.step(ArenaAction(op="submit", answer={})).reward == 0


def test_limits_and_no_host_reads():
    env = ArenaEnvironment()
    env.reset(seed=2)
    for path in ("/etc/passwd", "../../arena_env/tasks.py", "expected", "oracle", "file:///proc/self/environ"):
        obs = env.step(ArenaAction(op="read", path=path))
        assert obs.error and not obs.content and obs.reward == 0
    for _ in range(MAX_STEPS):
        obs = env.step(ArenaAction(op="list"))
    assert obs.done and obs.reward == 0
    with pytest.raises(ValidationError):
        ArenaAction(op="shell", path="cat /etc/passwd")
    with pytest.raises(ValidationError):
        ArenaAction(op="list", injected="ignored?")


def test_isolated_state_and_hidden_grading():
    first, second = ArenaEnvironment(), ArenaEnvironment()
    first.reset(seed=3)
    second.reset(seed=4)
    first.step(ArenaAction(op="submit", answer={}))
    assert not second.step(ArenaAction(op="list")).done
    state = second.state
    state.step_count = 100
    assert second.state.step_count == 1
    public = second.reset(seed=3).model_dump()
    assert not {"expected", "rubric", "seed", "answer"} & public.keys()
    with pytest.raises(ValueError):
        second.reset(task_id="nonexistent", seed=2)
    with pytest.raises(ValueError):
        second.reset(seed=True)


def test_websocket_protocol_and_concurrent_sessions():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        schema = client.get("/schema").json()
        assert set(("action", "observation", "state")) <= schema.keys()
        with client.websocket_connect("/ws") as first, client.websocket_connect("/ws") as second:
            for ws, seed in ((first, 10), (second, 11)):
                ws.send_json({"type": "reset", "data": {"task_id": TASK_IDS[0], "seed": seed}})
                result = ws.receive_json()
                assert result["type"] == "observation", result
            first.send_json({"type": "step", "data": {"op": "submit", "answer": {}}})
            end = first.receive_json()
            assert end["data"]["done"] and end["data"]["reward"] == 0
            second.send_json({"type": "step", "data": {"op": "read", "path": "*"}})
            read = second.receive_json()
            assert not read["data"]["done"]
            assert read["data"]["observation"]["content"]
