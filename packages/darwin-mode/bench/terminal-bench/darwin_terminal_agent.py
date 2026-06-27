# SPDX-License-Identifier: MIT
#
# Darwin Terminal-Bench adapter — a `BaseAgent` that drives a bounded ReAct loop against the
# official Terminal-Bench harness. This is a faithful PORT of our Node agentic solver
# (bench/swebench/agentic-loop.mjs) into the Python seam the harness exposes
# (terminal_bench/agents/base_agent.py).
#
# WHY a port and not a call: Terminal-Bench's only integration seam is a Python `BaseAgent`
# whose `perform_task(instruction, session)` runs commands inside the task's Docker container
# via a tmux session. The single "tool" the environment exposes is a SHELL. So the same ReAct
# shape (think → one action per turn, bounded step budget) is re-implemented here with one tool:
# run a bash command. The model edits files and runs the project's own commands with ordinary
# shell (cat, sed, here-docs, python -c, make, pytest, ...).
#
# SCORING IS NOT OURS. The harness builds/starts the container, hands us the session, and AFTER
# perform_task returns it runs the task's OWN hidden tests in the container and parses them
# (harness `_is_resolved` = all parsed unit tests PASS). We never see or run those tests — the
# loop is told NEVER to read or run anything under the tests/ dir. Leakage-free by construction.
#
# COST. Terminal-Bench records tokens, not dollars. We return token totals in AgentResult (so the
# official results.json stays correct) AND write a sidecar darwin-cost.jsonl (one row/task:
# task_id, model, input/output tokens, usd, steps, finished) from OpenRouter usage.cost. score.py
# joins the authoritative results.json (resolved/accuracy) with the sidecar ($) → the Pareto row.
#
# Constructed by the harness factory ONLY with --agent-kwarg (`-k k=v`); with --agent-import-path
# the harness does NOT forward --model to a custom agent, so the model is passed as `-k model=...`.
#
#   tb run --agent-import-path darwin_terminal_agent:DarwinTerminalAgent \
#          -k model=deepseek/deepseek-chat -k max_steps=25 \
#          -d terminal-bench-core==0.1.1 -t hello-world

import json
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

from pydantic import BaseModel
from terminal_bench.agents.base_agent import AgentResult, BaseAgent
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.terminal.tmux_session import TmuxSession

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Optional OpenAI-compatible endpoint override (e.g. a local ollama at $0 inference, or any
# OpenAI-compatible server). When set via -k base_url=... (or env DARWIN_BASE_URL), the agent
# posts to <base_url>/chat/completions with the same body. Default stays OpenRouter so the
# proven path is unchanged. usage.cost is absent on local endpoints → falls back to PRICE_TABLE
# (empty for local model slugs ⇒ $0, the honest cost for $0-inference local serving).

# Static fallback $/1M-token table for models OpenRouter sometimes omits usage.cost for. Only used
# when usage.cost is absent; the live usage.cost is always preferred (and is what we trust).
PRICE_TABLE = {
    "deepseek/deepseek-chat": (0.28, 0.88),
    "deepseek/deepseek-r1-0528": (0.50, 2.18),
    "z-ai/glm-4.6": (0.40, 1.75),
    "z-ai/glm-5.2": (0.40, 1.75),
    "moonshotai/kimi-k2": (0.50, 2.00),
    "anthropic/claude-opus-4.8": (5.0, 25.0),
}

SYSTEM = (
    "You are an autonomous command-line agent solving a task inside a real Linux Docker "
    "container. You control a shell. Each turn, output EXACTLY ONE JSON object on a single line "
    "and NOTHING else (no prose, no markdown fences, no XML). Tools:\n"
    '{"tool":"run","cmd":"<a single bash command>"}   run one shell command; returns its stdout/stderr\n'
    '{"tool":"submit"}                                 you are done; stop and let the grader run\n'
    "Rules:\n"
    "- ONE JSON action per turn. The shell is persistent (cwd, env, files carry across turns).\n"
    "- Use ordinary shell to inspect and EDIT files: cat, ls, grep, sed -i, python3 -c, and "
    "here-docs (cat > f <<'EOF' ... EOF) to write whole files.\n"
    "- A task is graded by HIDDEN tests AFTER you submit. NEVER cat, read, run, or modify anything "
    "under a tests/ directory or files named test_*/*_test — treat them as off-limits.\n"
    "- Verify your work with the project's own commands where possible, then submit.\n"
    "- Keep commands non-interactive (add flags like -y); avoid commands that hang waiting on input.\n"
    "Strategy: explore, make the change, sanity-check it, then submit."
)


class _Action(BaseModel):
    tool: str
    cmd: str | None = None


def _parse_action(raw: str) -> _Action:
    """Extract one {tool,...} JSON object, tolerating stray prose/fences (mirrors agentic-loop parseAction)."""
    if not raw:
        return _Action(tool="noop")
    s = re.sub(r"^>>>\s*", "", raw, flags=re.M)
    cands: list[str] = []
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fence:
        cands.append(fence.group(1))
    # depth-aware: collect ALL top-level {...} blocks (multi-action outputs don't hide the first)
    depth = 0
    start = -1
    for i, ch in enumerate(s):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                cands.append(s[start : i + 1])
    for c in cands:
        try:
            o = json.loads(c.strip())
            if isinstance(o, dict) and isinstance(o.get("tool"), str):
                return _Action(tool=o["tool"], cmd=o.get("cmd"))
        except Exception:
            continue
    return _Action(tool="noop")


class DarwinTerminalAgent(BaseAgent):
    """Bounded ReAct shell agent over OpenRouter, with per-task $ capture."""

    def __init__(
        self,
        model: str = "deepseek/deepseek-chat",
        max_steps: int = 25,
        temperature: float = 0.0,
        max_cost: float = 3.0,
        cost_sidecar: str | None = None,
        cmd_timeout_sec: float = 60.0,
        obs_cap: int = 4000,
        base_url: str | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.model = model
        self.max_steps = int(max_steps)
        self.temperature = float(temperature)
        self.max_cost = float(max_cost)
        self.cmd_timeout_sec = float(cmd_timeout_sec)
        self.obs_cap = int(obs_cap)
        # OpenAI-compatible endpoint. base_url override → "<base_url>/chat/completions";
        # default OpenRouter (unchanged). Strip a trailing /chat/completions if a full URL is given.
        _bu = base_url or os.environ.get("DARWIN_BASE_URL") or ""
        if _bu:
            _bu = _bu.rstrip("/")
            self.endpoint = _bu if _bu.endswith("/chat/completions") else _bu + "/chat/completions"
        else:
            self.endpoint = OPENROUTER_URL
        # sidecar: explicit kwarg, else env, else alongside this file
        self.cost_sidecar = Path(
            cost_sidecar
            or os.environ.get("DARWIN_COST_SIDECAR")
            or (Path(__file__).parent / "darwin-cost.jsonl")
        )
        self._api_key = os.environ.get("OPENROUTER_API_KEY", "")

    @staticmethod
    def name() -> str:
        return "darwin-terminal"

    @property
    def version(self) -> str:
        return self._version or "0.1"

    # ── OpenRouter call: returns (text, in_tok, out_tok, usd) ──────────────────────────────────
    def _llm(self, messages: list[dict]) -> tuple[str, int, int, float]:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": self.temperature,
                "usage": {"include": True},
            }
        ).encode()
        req = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key or 'local'}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/ruvnet/agent-harness-generator",
                "X-Title": "darwin-terminal-bench",
            },
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    j = json.loads(r.read().decode())
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
        text = (j.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        usage = j.get("usage") or {}
        in_tok = int(usage.get("prompt_tokens") or 0)
        out_tok = int(usage.get("completion_tokens") or 0)
        usd = usage.get("cost")
        if usd is None:
            pin, pout = PRICE_TABLE.get(self.model, (0.0, 0.0))
            usd = in_tok / 1e6 * pin + out_tok / 1e6 * pout
        return text, in_tok, out_tok, float(usd)

    # ── run one shell command in the task container via tmux, return delimited output ──────────
    def _run_cmd(self, session: TmuxSession, cmd: str) -> str:
        # ROBUST FRAMING (the §5 reliability fix): the model's command may be MULTI-LINE (heredocs,
        # `cat > f <<EOF ... EOF`, embedded newlines). Sending those raw to tmux line-by-line leaves
        # the shell stuck at a PS2 `> ` continuation prompt, and every later command silently feeds
        # that dead prompt while block=True burns its full timeout. We sidestep ALL of it by
        # base64-encoding the command and running it as a SINGLE physical line:
        #     printf %s '<b64>' | base64 -d | bash; echo MARKER$?
        # so newlines/quotes/heredocs survive intact and tmux only ever sees one line.
        import base64

        marker = f"__DARWIN_{int(time.time() * 1000) % 100000000}__"
        b64 = base64.b64encode(cmd.encode()).decode()
        wrapped = f"printf %s '{b64}' | base64 -d | bash; echo {marker}$?"
        try:
            session.send_keys(
                [wrapped, "Enter"],
                block=True,
                max_timeout_sec=self.cmd_timeout_sec,
            )
        except Exception as e:  # timeout / tmux error → report, keep the loop alive
            return f"[command error: {type(e).__name__}: {e}]"
        pane = session.capture_pane(capture_entire=True)
        # The pane shows the echoed wrapper line (contains `marker` inside the printf) and then the
        # real `echo MARKER<rc>` output line. We want the text BETWEEN the echoed wrapper and the
        # final marker. Strategy: split on the marker; the wrapper echo is the first occurrence, the
        # result is the last. Take what's between the first marker line's newline and the last marker.
        out = pane
        last = pane.rfind(marker)
        if last != -1:
            # find the end of the FIRST line that contains the marker (the echoed wrapper command)
            first = pane.find(marker)
            after_echo = pane.find("\n", first)
            body_start = after_echo + 1 if after_echo != -1 and after_echo < last else 0
            body = pane[body_start:last]
            # drop any residual line that still carries the wrapper (defensive) or is empty prompt noise
            kept = [ln for ln in body.splitlines() if marker not in ln and "base64 -d | bash" not in ln]
            tail = pane[last + len(marker):].splitlines()
            rc = tail[0].strip() if tail else "?"
            out = f"$ {cmd}\n" + "\n".join(kept).strip() + f"\n[exit {rc}]"
        if len(out) > self.obs_cap:
            out = out[: self.obs_cap] + f"\n…[truncated {len(out) - self.obs_cap} chars]"
        return out

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        # logging_dir layout = {output}/{task_id}/{trial_name}/agent-logs (TrialPaths). task_id is
        # two levels up from agent-logs.
        task_id = logging_dir.parent.parent.name if logging_dir else "unknown"
        in_tok = out_tok = 0
        usd = 0.0
        steps = 0
        failure = FailureMode.NONE
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"TASK:\n{instruction}\n\nBegin. Output one JSON action."},
        ]
        # OpenRouter needs a key; a local/custom endpoint (base_url override) does not.
        if not self._api_key and self.endpoint == OPENROUTER_URL:
            failure = FailureMode.UNKNOWN_AGENT_ERROR
        else:
            for steps in range(1, self.max_steps + 1):
                try:
                    text, i, o, c = self._llm(messages)
                except Exception as e:
                    failure = FailureMode.UNKNOWN_AGENT_ERROR
                    if logging_dir:
                        (logging_dir / "darwin-error.txt").write_text(str(e))
                    break
                in_tok += i
                out_tok += o
                usd += c
                messages.append({"role": "assistant", "content": text})
                action = _parse_action(text)
                if action.tool == "submit":
                    break
                if action.tool == "run" and action.cmd:
                    obs = self._run_cmd(session, action.cmd)
                else:
                    obs = (
                        "[no valid action parsed — reply with exactly one JSON object, e.g. "
                        '{"tool":"run","cmd":"ls"}]'
                    )
                messages.append({"role": "user", "content": obs})
                if usd >= self.max_cost:
                    if logging_dir:
                        (logging_dir / "darwin-budget.txt").write_text(
                            f"hit max_cost ${self.max_cost} at step {steps}"
                        )
                    break

        # cost sidecar (authoritative $). Append one row; score.py joins on task_id.
        try:
            row = {
                "task_id": task_id,
                "model": self.model,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "usd": round(usd, 6),
                "steps": steps,
                "failure_mode": failure.value,
                "ts": int(time.time()),
            }
            with self.cost_sidecar.open("a") as f:
                f.write(json.dumps(row) + "\n")
        except Exception:
            pass

        return AgentResult(
            total_input_tokens=in_tok,
            total_output_tokens=out_tok,
            failure_mode=failure,
        )
