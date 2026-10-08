"""Run the pinned OpenEnv validator against an actual local server process."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
base = f"http://127.0.0.1:{port}"
process = subprocess.Popen([sys.executable, "-m", "uvicorn", "arena_env.app:app", "--host", "127.0.0.1", "--port", str(port)], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for attempt in range(100):
        if process.poll() is not None:
            raise RuntimeError("server stopped before readiness: " + process.stderr.read().decode()[-4000:])
        try:
            with urllib.request.urlopen(base+"/health", timeout=.5) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError("server readiness timeout")
    (root / "evidence").mkdir(exist_ok=True)
    with urllib.request.urlopen(base+"/schema", timeout=5) as response:
        schema = json.load(response)
    (root / "evidence/schema.json").write_text(json.dumps(schema, indent=2)+"\n")
    result = subprocess.run([str(Path(sys.executable).parent/"openenv"), "validate", "--url", base, "--json", "--output", str(root/"evidence/openenv-runtime.json")], cwd=root, text=True, capture_output=True, timeout=60)
    print(result.stdout)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
finally:
    process.terminate()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
