"""Trusted preinstalled Vast runner. No installation, download, rental, or credentials.
Manifest lives at /workspace/curriculum-lab/manifests/<sha256>.json.
Trainer is fixed at /workspace/curriculum-lab/trainer.py and hash checked.
Use a dedicated isolated container. This runner is NOT a sandbox for hostile code.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import signal
import tempfile

ROOT = Path('/workspace/curriculum-lab')

def run(root, expected):
    if not re.fullmatch('[a-f0-9]{64}', expected):
        raise ValueError('invalid_manifest_hash')
    raw = (root / 'manifests' / (expected + '.json')).read_bytes()
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('manifest_hash_mismatch')
    manifest = json.loads(raw)
    if set(manifest) != {'trainerHash', 'maxSeconds', 'trainingSpec'}:
        raise ValueError('invalid_manifest')
    seconds = manifest['maxSeconds']
    if type(seconds) is not int or not 1 <= seconds <= 86400:
        raise ValueError('invalid_timeout')
    trainer = root / 'trainer.py'
    if hashlib.sha256(trainer.read_bytes()).hexdigest() != manifest['trainerHash']:
        raise ValueError('trainer_hash_mismatch')
    results = root / 'receipts'
    results.mkdir(mode=0o700, exist_ok=True)
    receipt = results / (expected + '.json')
    # Immutable intent before execution. Uncertain attempts require owner reconciliation.
    intent = results / (expected + '.intent')
    try:
        fd = os.open(intent, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if receipt.exists():
            return {'state': 'REUSED', 'receiptHash': hashlib.sha256(receipt.read_bytes()).hexdigest()}
        return {'state': 'HOLD', 'reason': 'prior_execution_uncertain'}
    with os.fdopen(fd, 'w') as f:
        f.write(expected)
        f.flush()
        os.fsync(f.fileno())
    result = {'state': 'INCONCLUSIVE', 'manifestHash': expected, 'promote': False}
    with tempfile.TemporaryDirectory(prefix='curriculum-job-') as work:
        output = Path(work) / 'result.json'
        # Trusted trainer reads public training spec on stdin, writes JSON to supplied path.
        # Output is capped by trainer contract; raw stdout/stderr never returned by control plane.
        try:
            p = subprocess.Popen(['python3', str(trainer), '--output', str(output)],
                stdin=subprocess.PIPE, cwd=work, start_new_session=True,
                env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
            try:
                p.communicate(json.dumps(manifest['trainingSpec']).encode(), timeout=seconds)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.communicate()
                raise
            result['exitCode'] = p.returncode
            if p.returncode == 0 and output.is_file() and output.stat().st_size <= 1048576:
                data = json.loads(output.read_text())
                # Control-plane receipt carries integrity references, never raw model text.
                result.update(state='COMPLETED_UNREVIEWED', resultHash=hashlib.sha256(output.read_bytes()).hexdigest())
                (results / (expected + '.trainer.json')).write_text(json.dumps(data))
                os.chmod(results / (expected + '.trainer.json'), 0o600)
        except subprocess.TimeoutExpired:
            result['reason'] = 'timeout'
        except (OSError, ValueError):
            result['reason'] = 'invalid_trainer_result'
    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(result,f); f.flush(); os.fsync(f.fileno())
    return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest-sha256',required=True)
    args=parser.parse_args()
    try:
        print(json.dumps(run(ROOT,args.manifest_sha256)))
    except Exception:
        print(json.dumps({'state':'HOLD','reason':'runner_validation_failed','promote':False}))
        raise SystemExit(1)
