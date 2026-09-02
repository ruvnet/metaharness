#!/usr/bin/env python3
"""Strict JSON-lines bridge to the official ARC-AGI-3 Python SDK.

The process owns the SDK's cookie-bearing ``Arcade`` instance.  Nothing except
protocol responses is written to stdout; SDK diagnostics are redirected to
stderr so a log line can never be mistaken for a response.
"""

from __future__ import annotations

import argparse
import contextlib
from importlib.metadata import PackageNotFoundError, version
import json
import logging
import os
import re
import sys
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable
from urllib.parse import urlsplit


EXPECTED_SDK_VERSIONS = {
    "arc-agi": "0.9.8",
    "arcengine": "0.9.3",
}


def _require_pinned_sdk_versions() -> None:
    try:
        installed = {name: version(name) for name in EXPECTED_SDK_VERSIONS}
    except PackageNotFoundError:
        sys.stderr.write("CONFIGURATION_ERROR: pinned ARC SDK packages are required\n")
        raise SystemExit(2) from None
    if installed != EXPECTED_SDK_VERSIONS:
        sys.stderr.write("CONFIGURATION_ERROR: ARC SDK package versions do not match the bridge lock\n")
        raise SystemExit(2)


_require_pinned_sdk_versions()

# arc_agi.scorecard installs a stdout logging handler while it is imported.
# Import it while stdout points at stderr, then replace its handler as a second
# line of defence.  This keeps stdout a protocol-only channel.
with contextlib.redirect_stdout(sys.stderr):
    from arc_agi import Arcade, OperationMode
    from arcengine import GameAction


MAX_REQUEST_LINE_BYTES = 1_048_576
MAX_RESPONSE_LINE_BYTES = 8 * 1_048_576
MAX_REASONING_BYTES = 16_000
MAX_ANIMATION_FRAMES = 256
MAX_OBSERVATION_CELLS = 1_048_576
MAX_METADATA_BYTES = 128 * 1_024
MAX_METADATA_ITEMS = 65_536
MAX_METADATA_DEPTH = 32
DEFAULT_BASE_URL = "https://three.arcprize.org"
DEFAULT_ALLOWED_BASE_HOSTS = ("three.arcprize.org",)
ACTION_NAMES = tuple(["RESET", *[f"ACTION{i}" for i in range(1, 8)]])
SENSITIVE_KEY_NAMES = {
    "api_key",
    "apikey",
    "arc_api_key",
    "anonymous_api_key",
    "x-api-key",
}


class BridgeError(Exception):
    """A safe, client-visible bridge error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _validate_allowed_host(value: str) -> str:
    host = value.strip().lower()
    if (
        not host
        or host.endswith(".")
        or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host)
    ):
        raise BridgeError(
            "CONFIGURATION_ERROR", "Allowed ARC hosts must be exact DNS hostnames"
        )
    return host


def _validated_base_url(value: str, allowed_hosts: tuple[str, ...]) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise BridgeError("CONFIGURATION_ERROR", "ARC_BASE_URL is invalid") from error
    if (
        parsed.scheme.lower() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.hostname is None
        or parsed.hostname.lower() not in allowed_hosts
        or port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise BridgeError(
            "CONFIGURATION_ERROR",
            "ARC_BASE_URL must be an allowed HTTPS origin with no credentials, path, query, or fragment",
        )
    return f"https://{parsed.hostname.lower()}"


def _parse_allowed_base_hosts(argv: list[str]) -> tuple[str, ...]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--allowed-arc-host", action="append", default=None)
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        raise BridgeError("CONFIGURATION_ERROR", "Unknown bridge command argument")
    values = args.allowed_arc_host or list(DEFAULT_ALLOWED_BASE_HOSTS)
    hosts = tuple(dict.fromkeys(_validate_allowed_host(value) for value in values))
    if not hosts:
        raise BridgeError("CONFIGURATION_ERROR", "At least one ARC host is required")
    return hosts


class _SecretFilter(logging.Filter):
    """Redact known keys and key-looking values from SDK log records."""

    _KEY_PATTERN = re.compile(
        r"(?i)((?:anonymous[ _-]?)?(?:arc[ _-]?)?api[ _-]?key\s*[:=]\s*)"
        r"([^\s,;]+)"
    )

    def __init__(self) -> None:
        super().__init__()
        self._secrets: set[str] = set()

    def add_secret(self, value: Any) -> None:
        secret = str(value or "")
        if len(secret) >= 8:
            self._secrets.add(secret)

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        for secret in (*_known_secrets(), *self._secrets):
            message = message.replace(secret, "[REDACTED]")
        message = self._KEY_PATTERN.sub(r"\1[REDACTED]", message)
        record.msg = message
        record.args = ()
        return True


def _known_secrets(arcade: Any | None = None) -> tuple[str, ...]:
    candidates = [os.getenv("ARC_API_KEY", "")]
    if arcade is not None:
        candidates.append(str(getattr(arcade, "arc_api_key", "") or ""))
    # Avoid replacing tiny/common strings in otherwise harmless messages.
    return tuple(value for value in candidates if len(value) >= 8)


LOG_FILTER = _SecretFilter()


def _configure_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    handler.addFilter(LOG_FILTER)

    logger = logging.getLogger("arc_agi_bridge")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.WARNING)
    logger.propagate = False

    # The SDK module owns a non-propagating handler created at import time.
    scorecard_logger = logging.getLogger("arc_agi.scorecard")
    scorecard_logger.handlers.clear()
    scorecard_logger.addHandler(handler)
    scorecard_logger.setLevel(logging.WARNING)
    scorecard_logger.propagate = False
    return logger


LOGGER = _configure_logging()


def _safe_message(error: BaseException, arcade: Any | None = None) -> str:
    message = str(error) or error.__class__.__name__
    for secret in _known_secrets(arcade):
        message = message.replace(secret, "[REDACTED]")
    message = _SecretFilter._KEY_PATTERN.sub(r"\1[REDACTED]", message)
    # Error responses are diagnostics, not an unbounded data channel.
    return message[:2_000]


@dataclass
class _JsonBudget:
    items: int = 0
    string_bytes: int = 0

    def consume(self, value: Any, depth: int) -> None:
        if depth > MAX_METADATA_DEPTH:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata nesting is too deep")
        self.items += 1
        if self.items > MAX_METADATA_ITEMS:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata contains too many items")
        if isinstance(value, str):
            self.string_bytes += len(value.encode("utf-8"))
            if self.string_bytes > MAX_METADATA_BYTES:
                raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata strings are too large")


def _jsonable(value: Any, budget: _JsonBudget | None = None, depth: int = 0) -> Any:
    """Convert SDK/Pydantic/numpy values without exposing credential fields."""

    if budget is not None:
        budget.consume(value, depth)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return _jsonable(value.value, budget, depth + 1)
    if hasattr(value, "model_dump"):
        return _jsonable(
            value.model_dump(mode="json", exclude_none=True), budget, depth + 1
        )
    if hasattr(value, "tolist"):
        size = getattr(value, "size", None)
        if budget is not None and isinstance(size, int) and size > MAX_METADATA_ITEMS:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata array is too large")
        return _jsonable(value.tolist(), budget, depth + 1)
    if hasattr(value, "item"):
        return _jsonable(value.item(), budget, depth + 1)
    if isinstance(value, dict):
        return {
            str(key): _jsonable(item, budget, depth + 1)
            for key, item in value.items()
            if str(key).lower() not in SENSITIVE_KEY_NAMES
        }
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item, budget, depth + 1) for item in value]
    raise BridgeError(
        "SDK_SERIALIZATION_ERROR",
        f"Unsupported SDK value type: {value.__class__.__name__}",
    )


def _required_string(params: dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value.strip():
        raise BridgeError("INVALID_REQUEST", f"{name} must be a non-empty string")
    return value


def _optional_scorecard_id(params: dict[str, Any]) -> str | None:
    value = params.get("scorecardId")
    if value is not None and (not isinstance(value, str) or not value.strip()):
        raise BridgeError(
            "INVALID_REQUEST", "scorecardId must be a non-empty string"
        )
    return value


def _require_keys(
    params: dict[str, Any], allowed: set[str], required: set[str] = set()
) -> None:
    extra = set(params) - allowed
    missing = required - set(params)
    if extra:
        raise BridgeError(
            "INVALID_REQUEST", f"Unexpected parameter(s): {', '.join(sorted(extra))}"
        )
    if missing:
        raise BridgeError(
            "INVALID_REQUEST", f"Missing parameter(s): {', '.join(sorted(missing))}"
        )


def _action_name_from_id(action_id: Any) -> str:
    if isinstance(action_id, Enum):
        action_id = action_id.value
    if isinstance(action_id, bool) or not isinstance(action_id, int):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK offered a non-integer action")
    if not 0 <= action_id <= 7:
        raise BridgeError("SDK_PROTOCOL_ERROR", f"SDK offered action id {action_id}")
    return ACTION_NAMES[action_id]


def _action_input(raw: Any) -> Any:
    action_input = getattr(raw, "action_input", None)
    if action_input is None:
        return None
    serialized = _jsonable(action_input, _JsonBudget())
    if not isinstance(serialized, dict):
        return serialized
    action_id = getattr(action_input, "id", None)
    if action_id is not None:
        if isinstance(action_id, Enum):
            serialized["id"] = action_id.value
            serialized["name"] = action_id.name
        elif isinstance(action_id, int) and not isinstance(action_id, bool):
            serialized["id"] = action_id
            if 0 <= action_id <= 7:
                serialized["name"] = ACTION_NAMES[action_id]
    return serialized


def _grid_frame(frame: Any, index: int) -> dict[str, Any]:
    shape = getattr(frame, "shape", None)
    if shape is not None:
        try:
            dimensions = tuple(int(value) for value in shape)
        except (TypeError, ValueError) as error:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame shape is invalid") from error
        if len(dimensions) != 2 or any(value < 1 or value > 64 for value in dimensions):
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame dimensions are outside the bridge limit")
    elif isinstance(frame, (list, tuple)):
        if not 1 <= len(frame) <= 64:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame height is outside the bridge limit")
        if any(not isinstance(row, (list, tuple)) or not 1 <= len(row) <= 64 for row in frame):
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame row is outside the bridge limit")
    cells = _jsonable(frame)
    if not isinstance(cells, list) or any(not isinstance(row, list) for row in cells):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame must be a 2D grid")
    height = len(cells)
    width = len(cells[0]) if height else 0
    if any(len(row) != width for row in cells):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK frame rows must be rectangular")
    if not 1 <= height <= 64 or not 1 <= width <= 64:
        raise BridgeError(
            "SDK_PROTOCOL_ERROR", "SDK frame dimensions must each be from 1 through 64"
        )
    for row in cells:
        for cell in row:
            if (
                isinstance(cell, bool)
                or not isinstance(cell, int)
                or not 0 <= cell <= 15
            ):
                raise BridgeError(
                    "SDK_PROTOCOL_ERROR",
                    "SDK frame cells must be integers from 0 through 15",
                )
    return {
        "width": width,
        "height": height,
        "cells": cells,
        "frameIndex": index,
    }


def _observation(raw: Any) -> dict[str, Any]:
    if raw is None:
        raise BridgeError("SDK_ERROR", "ARC SDK returned no observation")

    state = getattr(raw, "state", None)
    state_value = state.value if isinstance(state, Enum) else str(state)
    if state_value not in {"NOT_PLAYED", "NOT_FINISHED", "WIN", "GAME_OVER"}:
        raise BridgeError("SDK_PROTOCOL_ERROR", f"Unexpected game state: {state_value}")

    levels_completed = getattr(raw, "levels_completed", None)
    win_levels = getattr(raw, "win_levels", None)
    if (
        isinstance(levels_completed, bool)
        or not isinstance(levels_completed, int)
        or not 0 <= levels_completed <= 9_007_199_254_740_991
        or isinstance(win_levels, bool)
        or not isinstance(win_levels, int)
        or not 0 <= win_levels <= 9_007_199_254_740_991
    ):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK returned invalid progress values")

    offered_ids: list[Any] = []
    for action_id in getattr(raw, "available_actions", []) or []:
        if len(offered_ids) >= len(ACTION_NAMES):
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK offered too many actions")
        offered_ids.append(action_id)
    offered_names = [_action_name_from_id(action_id) for action_id in offered_ids]
    if len(set(offered_names)) != len(offered_names):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK offered a duplicate action")
    frames: list[dict[str, Any]] = []
    total_cells = 0
    for index, frame in enumerate(getattr(raw, "frame", []) or []):
        if index >= MAX_ANIMATION_FRAMES:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK returned too many animation frames")
        converted = _grid_frame(frame, index)
        total_cells += converted["width"] * converted["height"]
        if total_cells > MAX_OBSERVATION_CELLS:
            raise BridgeError("SDK_PROTOCOL_ERROR", "SDK observation contains too many cells")
        frames.append(converted)
    if not frames:
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK returned no animation frames")

    sdk_progress = getattr(raw, "progress", None)
    progress = (
        _jsonable(sdk_progress, _JsonBudget())
        if sdk_progress is not None
        else {
            "levelsCompleted": levels_completed,
            "winLevels": win_levels,
        }
    )
    game_id = str(getattr(raw, "game_id", ""))
    guid = getattr(raw, "guid", None)
    if len(game_id) > 1_024 or (guid is not None and (not isinstance(guid, str) or len(guid) > 1_024)):
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK identity metadata is invalid")
    metadata = {
        "gameId": game_id,
        "guid": guid,
        "fullReset": bool(getattr(raw, "full_reset", False)),
        "actionInput": _action_input(raw),
        "progress": progress,
        "offeredActionIds": offered_ids,
    }
    try:
        metadata_size = len(json.dumps(
            metadata, ensure_ascii=True, allow_nan=False, separators=(",", ":")
        ).encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata is not valid JSON") from error
    if metadata_size > MAX_METADATA_BYTES:
        raise BridgeError("SDK_PROTOCOL_ERROR", "SDK metadata exceeds the bridge limit")
    return {
        "state": state_value,
        "levelsCompleted": levels_completed,
        "winLevels": win_levels,
        "availableActions": offered_names,
        "frames": frames,
        "metadata": metadata,
    }


def _validate_reasoning(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise BridgeError("INVALID_REASONING", "reasoning must be a JSON object")
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise BridgeError("INVALID_REASONING", "reasoning must be valid JSON") from error
    if len(encoded) > MAX_REASONING_BYTES:
        raise BridgeError(
            "REASONING_TOO_LARGE",
            f"reasoning JSON exceeds {MAX_REASONING_BYTES} bytes",
        )
    return value


def _validate_action(value: Any) -> tuple[GameAction, dict[str, int]]:
    if not isinstance(value, dict):
        raise BridgeError("INVALID_ACTION", "action must be an object")
    name = value.get("name")
    if not isinstance(name, str) or name not in ACTION_NAMES:
        raise BridgeError(
            "INVALID_ACTION", "action.name must be RESET or ACTION1 through ACTION7"
        )

    if name == "ACTION6":
        if set(value) != {"name", "x", "y"}:
            raise BridgeError(
                "INVALID_ACTION", "ACTION6 requires exactly name, x, and y"
            )
        x = value["x"]
        y = value["y"]
        if (
            isinstance(x, bool)
            or not isinstance(x, int)
            or isinstance(y, bool)
            or not isinstance(y, int)
            or not 0 <= x <= 63
            or not 0 <= y <= 63
        ):
            raise BridgeError(
                "INVALID_ACTION", "ACTION6 x and y must be integers from 0 through 63"
            )
        data = {"x": x, "y": y}
    else:
        if set(value) != {"name"}:
            raise BridgeError(
                "INVALID_ACTION", f"{name} accepts no action parameters"
            )
        data = {}

    try:
        action = GameAction.from_name(name)
        action.validate_data(data)
    except (TypeError, ValueError) as error:
        raise BridgeError("INVALID_ACTION", f"Invalid {name} payload") from error
    return action, data


@dataclass
class _EnvironmentRecord:
    environment: Any
    scorecard_id: str


class BridgeService:
    """Serial request dispatcher around one official SDK ``Arcade``."""

    def __init__(
        self,
        arcade_factory: Callable[..., Any] = Arcade,
        allowed_base_hosts: tuple[str, ...] = DEFAULT_ALLOWED_BASE_HOSTS,
    ) -> None:
        self._arcade_factory = arcade_factory
        self._allowed_base_hosts = tuple(
            _validate_allowed_host(host) for host in allowed_base_hosts
        )
        self._arcade: Any | None = None
        self._environments: dict[str, _EnvironmentRecord] = {}
        self._scorecard_ids: set[str] = set()

    @property
    def arcade(self) -> Any:
        if self._arcade is None:
            mode_text = os.getenv(
                "ARC_OPERATION_MODE", os.getenv("OPERATION_MODE", "online")
            ).strip().lower()
            try:
                mode = OperationMode(mode_text)
            except ValueError as error:
                raise BridgeError(
                    "CONFIGURATION_ERROR",
                    "ARC_OPERATION_MODE must be online or competition",
                ) from error

            if mode_text not in {"online", "competition"}:
                raise BridgeError(
                    "CONFIGURATION_ERROR",
                    "ARC_OPERATION_MODE must be online or competition",
                )

            base_url = _validated_base_url(
                os.getenv("ARC_BASE_URL", DEFAULT_BASE_URL).strip(),
                self._allowed_base_hosts,
            )
            if not base_url:
                raise BridgeError("CONFIGURATION_ERROR", "ARC_BASE_URL cannot be empty")

            # Passing ONLINE explicitly avoids the SDK's NORMAL default.  Redirect
            # any incidental prints from SDK initialization as well as its logs.
            with contextlib.redirect_stdout(sys.stderr):
                self._arcade = self._arcade_factory(
                    arc_api_key=os.getenv("ARC_API_KEY", ""),
                    arc_base_url=base_url,
                    operation_mode=mode,
                    logger=LOGGER,
                )
            # Anonymous credentials are minted during SDK construction.  Add the
            # resulting value to the filter before any later SDK operation logs.
            LOG_FILTER.add_secret(getattr(self._arcade, "arc_api_key", ""))
        return self._arcade

    def _environment(self, environment_id: Any) -> _EnvironmentRecord:
        if not isinstance(environment_id, str) or not environment_id:
            raise BridgeError(
                "INVALID_REQUEST", "environmentId must be a non-empty string"
            )
        record = self._environments.get(environment_id)
        if record is None:
            raise BridgeError("UNKNOWN_ENVIRONMENT", "Unknown environmentId")
        return record

    def dispatch(self, operation: str, params: dict[str, Any]) -> tuple[Any, bool]:
        if operation == "list_games":
            _require_keys(params, set())
            with contextlib.redirect_stdout(sys.stderr):
                games = self.arcade.get_environments()
            return [_jsonable(game) for game in games], False

        if operation in {"create_scorecard", "open_scorecard"}:
            _require_keys(params, {"sourceUrl", "tags", "opaque"})
            source_url = params.get("sourceUrl")
            tags = params.get("tags")
            if source_url is not None and not isinstance(source_url, str):
                raise BridgeError("INVALID_REQUEST", "sourceUrl must be a string")
            if tags is not None and (
                not isinstance(tags, list)
                or any(not isinstance(tag, str) for tag in tags)
            ):
                raise BridgeError("INVALID_REQUEST", "tags must be an array of strings")
            method = (
                self.arcade.open_scorecard
                if operation == "open_scorecard"
                else self.arcade.create_scorecard
            )
            with contextlib.redirect_stdout(sys.stderr):
                scorecard_id = method(source_url, tags, params.get("opaque"))
            if not isinstance(scorecard_id, str) or not scorecard_id:
                raise BridgeError("SDK_ERROR", "ARC SDK returned no scorecard id")
            self._scorecard_ids.add(scorecard_id)
            return {"scorecardId": scorecard_id}, False

        if operation == "start_game":
            _require_keys(
                params,
                {"gameId", "scorecardId", "seed"},
                {"gameId", "scorecardId"},
            )
            game_id = _required_string(params, "gameId")
            scorecard_id = _required_string(params, "scorecardId")
            seed = params.get("seed", 0)
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise BridgeError("INVALID_REQUEST", "seed must be an integer")
            with contextlib.redirect_stdout(sys.stderr):
                environment = self.arcade.make(
                    game_id=game_id,
                    seed=seed,
                    scorecard_id=scorecard_id,
                    save_recording=False,
                    include_frame_data=True,
                    render_mode=None,
                )
                if environment is None:
                    raise BridgeError("SDK_ERROR", f"Game is unavailable: {game_id}")
                # Official wrappers populate observation_space by calling
                # env.reset() during Arcade.make().  Reuse that initial full
                # reset so it is neither duplicated nor counted.  A custom or
                # future wrapper that does not eagerly reset gets one explicit
                # reset here.
                initial = environment.observation_space
                if initial is None:
                    initial = environment.reset()
            environment_id = f"env-{uuid.uuid4()}"
            self._environments[environment_id] = _EnvironmentRecord(
                environment=environment,
                scorecard_id=scorecard_id,
            )
            return {
                "environmentId": environment_id,
                "observation": _observation(initial),
            }, False

        if operation == "observe":
            _require_keys(params, {"environmentId"}, {"environmentId"})
            record = self._environment(params.get("environmentId"))
            return _observation(record.environment.observation_space), False

        if operation == "reset":
            _require_keys(params, {"environmentId"}, {"environmentId"})
            record = self._environment(params.get("environmentId"))
            with contextlib.redirect_stdout(sys.stderr):
                observation = record.environment.reset()
            return _observation(observation), False

        if operation == "act":
            _require_keys(
                params,
                {"environmentId", "action", "reasoning"},
                {"environmentId", "action"},
            )
            record = self._environment(params.get("environmentId"))
            action, data = _validate_action(params.get("action"))
            reasoning = _validate_reasoning(params.get("reasoning"))
            if action == GameAction.RESET:
                if reasoning is not None:
                    raise BridgeError(
                        "INVALID_REASONING", "RESET does not accept reasoning"
                    )
                with contextlib.redirect_stdout(sys.stderr):
                    observation = record.environment.reset()
                return _observation(observation), False

            current = record.environment.observation_space
            if current is None:
                raise BridgeError("SDK_ERROR", "Game has no current observation")
            offered = list(getattr(current, "available_actions", []) or [])
            if action.value not in offered:
                raise BridgeError(
                    "ACTION_NOT_AVAILABLE", f"{action.name} is not currently offered"
                )
            with contextlib.redirect_stdout(sys.stderr):
                observation = record.environment.step(
                    action,
                    data=data or None,
                    reasoning=reasoning,
                )
            return _observation(observation), False

        if operation == "get_scorecard":
            _require_keys(params, {"scorecardId"})
            scorecard_id = _optional_scorecard_id(params)
            with contextlib.redirect_stdout(sys.stderr):
                scorecard = self.arcade.get_scorecard(scorecard_id)
            return _jsonable(scorecard), False

        if operation == "close_scorecard":
            _require_keys(params, {"scorecardId"})
            scorecard_id = _optional_scorecard_id(params)
            with contextlib.redirect_stdout(sys.stderr):
                scorecard = self.arcade.close_scorecard(scorecard_id)
            if scorecard_id is not None:
                self._scorecard_ids.discard(scorecard_id)
                self._environments = {
                    environment_id: record
                    for environment_id, record in self._environments.items()
                    if record.scorecard_id != scorecard_id
                }
            return _jsonable(scorecard), False

        if operation == "shutdown":
            _require_keys(params, set())
            closed_scorecards = 0
            failed_scorecards = 0
            # Intentional shutdown owns cleanup.  Abrupt OS/process loss is the
            # only path on which the bridge cannot make this guarantee.
            if self._arcade is not None:
                for scorecard_id in sorted(self._scorecard_ids):
                    try:
                        with contextlib.redirect_stdout(sys.stderr):
                            self.arcade.close_scorecard(scorecard_id)
                        closed_scorecards += 1
                    except Exception as error:
                        failed_scorecards += 1
                        LOGGER.warning(
                            "failed to close scorecard during shutdown: %s",
                            _safe_message(error, self._arcade),
                        )
            self._scorecard_ids.clear()
            self._environments.clear()
            return {
                "closed": True,
                "closedScorecards": closed_scorecards,
                "failedScorecards": failed_scorecards,
            }, True

        raise BridgeError("UNKNOWN_OPERATION", f"Unknown operation: {operation}")


def _parse_request(raw_line: bytes) -> tuple[str | int | None, str, dict[str, Any]]:
    try:
        request = json.loads(
            raw_line.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise BridgeError("MALFORMED_JSON", "Request is not valid JSON") from error
    if not isinstance(request, dict):
        raise BridgeError("INVALID_REQUEST", "Request must be an object")
    if set(request) - {"id", "op", "params"}:
        raise BridgeError("INVALID_REQUEST", "Request has unexpected fields")
    request_id = request.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        raise BridgeError("INVALID_REQUEST", "id must be a string or integer")
    operation = request.get("op")
    if not isinstance(operation, str) or not operation:
        raise BridgeError("INVALID_REQUEST", "op must be a non-empty string")
    params = request.get("params", {})
    if not isinstance(params, dict):
        raise BridgeError("INVALID_REQUEST", "params must be an object")
    return request_id, operation, params


def _write_response(payload: dict[str, Any]) -> None:
    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as error:
        # This is an internal invariant failure.  Emit a bounded valid response.
        encoded = json.dumps(
            {
                "id": payload.get("id"),
                "ok": False,
                "error": {
                    "code": "SDK_SERIALIZATION_ERROR",
                    "message": _safe_message(error),
                },
            },
            separators=(",", ":"),
        )
    if len(encoded.encode("utf-8")) > MAX_RESPONSE_LINE_BYTES:
        encoded = json.dumps(
            {
                "id": payload.get("id"),
                "ok": False,
                "error": {
                    "code": "RESPONSE_TOO_LARGE",
                    "message": f"Response exceeds {MAX_RESPONSE_LINE_BYTES} bytes",
                },
            },
            separators=(",", ":"),
        )
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def _drain_oversized_line(stream: Any) -> None:
    while True:
        chunk = stream.readline(MAX_REQUEST_LINE_BYTES + 1)
        if not chunk or chunk.endswith(b"\n"):
            return


def main() -> int:
    try:
        allowed_base_hosts = _parse_allowed_base_hosts(sys.argv[1:])
    except BridgeError as error:
        LOGGER.error("bridge configuration failed (%s): %s", error.code, error)
        return 2
    service = BridgeService(allowed_base_hosts=allowed_base_hosts)
    stream = sys.stdin.buffer
    while True:
        raw_line = stream.readline(MAX_REQUEST_LINE_BYTES + 1)
        if not raw_line:
            break
        if len(raw_line) > MAX_REQUEST_LINE_BYTES:
            if not raw_line.endswith(b"\n"):
                _drain_oversized_line(stream)
            _write_response(
                {
                    "id": None,
                    "ok": False,
                    "error": {
                        "code": "REQUEST_TOO_LARGE",
                        "message": f"Request exceeds {MAX_REQUEST_LINE_BYTES} bytes",
                    },
                }
            )
            continue
        if not raw_line.strip():
            continue

        request_id: str | int | None = None
        should_stop = False
        try:
            request_id, operation, params = _parse_request(raw_line)
            result, should_stop = service.dispatch(operation, params)
            response = {"id": request_id, "ok": True, "result": result}
        except BridgeError as error:
            message = _safe_message(error, service._arcade)
            LOGGER.warning("bridge request failed (%s): %s", error.code, message)
            response = {
                "id": request_id,
                "ok": False,
                "error": {"code": error.code, "message": message},
            }
        except Exception as error:  # fail closed; never expose a traceback or key
            message = _safe_message(error, service._arcade)
            LOGGER.error("ARC SDK request failed: %s", message)
            response = {
                "id": request_id,
                "ok": False,
                "error": {"code": "SDK_ERROR", "message": message},
            }
        _write_response(response)
        if should_stop:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
