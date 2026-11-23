"""Reviewed host entrypoint. One HF proposal; credentials never enter evaluation."""
import os
from pathlib import Path
import subprocess
import sys
from ruos_secret import load_bound_secret

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('evidence_directory_required')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin',
               'HF_TOKEN': load_bound_secret('HF_TOKEN')}
        result = subprocess.run(['node', str(Path(__file__).with_suffix('.mjs')),
                                 str(Path(sys.argv[1]).resolve())],
                                env=env, timeout=120, check=False)
        sys.exit(result.returncode)
    except Exception:
        print('{"status":"INCONCLUSIVE","reason":"host_execution_failed"}')
        sys.exit(1)
