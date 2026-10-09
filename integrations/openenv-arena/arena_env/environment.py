"""A bounded virtual-file environment, with no shell or filesystem capabilities."""
from __future__ import annotations

import json
import secrets
from typing import Any, Literal
from uuid import uuid4

from openenv.core.env_server.interfaces import Environment
from openenv.core.env_server.types import Action, Observation, State
from pydantic import Field

from .tasks import TASK_IDS, make_task, grade, parse_task_id

MAX_STEPS = 16
MAX_ANSWER_BYTES = 16384


class ArenaAction(Action):
    op: Literal["list", "read", "submit"] = Field(description="List files, read a file (or * for all), or submit the final structured answer once.")
    path: str = Field(default="", description="Exact virtual filename, or * to read all files.")
    answer: dict[str, Any] = Field(default_factory=dict, description="For submit: answer object matching the prompt. An empty object ends with reward zero.")


class ArenaObservation(Observation):
    task_id: str = ""
    prompt: str = ""
    files: list[str] = Field(default_factory=list)
    content: str = ""
    error: str = ""
    remaining_steps: int = 0


class ArenaEnvironment(Environment[ArenaAction, ArenaObservation, State]):
    SUPPORTS_CONCURRENT_SESSIONS = True

    def __init__(self):
        super().__init__()
        self._state = State(episode_id=str(uuid4()), step_count=0)
        self._task: dict[str, Any] | None = None
        self._done = False
        self._reward = 0.0

    def reset(self, seed: int | None = None, episode_id: str | None = None, **kwargs: Any) -> ArenaObservation:
        task_id = kwargs.get("task_id", TASK_IDS[0])
        family, difficulty, params = parse_task_id(task_id)
        if seed is None:
            seed = secrets.randbelow(2**63)
        if type(seed) is not int or seed < 0 or seed >= 2**64:
            raise ValueError("seed must be an unsigned 64 bit integer")
        self._task = make_task(family, seed, difficulty, params)
        self._state = State(episode_id=episode_id or str(uuid4()), step_count=0)
        self._done, self._reward = False, 0.0
        return self._observe(prompt=self._task["prompt"] + "\nUse read with path * to read all files in one call. Then submit your answer object once. No shell is available.", files=sorted(self._task["files"]))

    def _observe(self, **fields: Any) -> ArenaObservation:
        return ArenaObservation(task_id=self._task["task_id"] if self._task else "", done=self._done, reward=self._reward, remaining_steps=max(0, MAX_STEPS-self._state.step_count), **fields)

    def step(self, action: ArenaAction, timeout_s: float | None = None, **kwargs: Any) -> ArenaObservation:
        if self._task is None:
            raise RuntimeError("reset required")
        if self._done:
            return self._observe(error="episode is terminal; reset before another attempt")
        self._state.step_count += 1
        if action.op == "submit":
            self._done = True
            try:
                encoded = json.dumps(action.answer, allow_nan=False, separators=(",", ":"))
                self._reward = grade(self._task, action.answer) if len(encoded.encode()) <= MAX_ANSWER_BYTES else 0.0
            except (ValueError, TypeError, RecursionError):
                self._reward = 0.0
            return self._observe()
        if self._state.step_count >= MAX_STEPS:
            self._done = True
            return self._observe(error="step budget exhausted")
        if action.op == "list":
            return self._observe(files=sorted(self._task["files"]))
        if action.path == "*":
            return self._observe(content=json.dumps(self._task["files"], ensure_ascii=True, separators=(",", ":")))
        if action.path not in self._task["files"]:
            return self._observe(error="unknown virtual file; use list for exact names")
        return self._observe(content=self._task["files"][action.path])

    @property
    def state(self) -> State:
        return self._state.model_copy(deep=True)
