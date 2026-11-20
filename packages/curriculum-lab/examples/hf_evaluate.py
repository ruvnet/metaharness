"""Independent deterministic toy scoring, no provider access or credentials."""
import hashlib
import json
import os
from pathlib import Path
import sys
from local_learning import cases, probability, train

def evaluate(directory, width):
    if any(k.endswith('TOKEN') or k.endswith('API_KEY') for k in os.environ):
        raise ValueError('unexpected_credentials')
    if width not in (3, 5):
        raise ValueError('unsupported_single_step')
    rows = []
    traces = []
    for seed in (7, 19, 31):
        baseline, n = train([4, 4, 4], seed)
        candidate, m = train([width, width, width], seed)
        assert n == m == 3600
        scores = {}
        for label, weights in [('baseline', baseline), ('candidate', candidate)]:
            correct = 0
            for test_width in (4, 8):
                for index, (x, target) in enumerate(cases(seed + 10000, 1000, test_width)):
                    action = int(probability(weights, x) > .5)
                    success = action == target
                    correct += success
                    traces.append(dict(seed=seed+10000,width=test_width,index=index,
                                       arm=label,x=x,target=target,action=action,success=success))
            scores[label] = correct / 2000
        rows.append(dict(seed=seed,updatesPerArm=n,baselineWeights=baseline,
                         candidateWeights=candidate,**scores))
    raw=json.dumps(traces,sort_keys=True,separators=(',',':')).encode()
    trajectory_hash=hashlib.sha256(raw).hexdigest()
    path=Path(directory)/('trajectories-'+trajectory_hash+'.json')
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f: f.write(raw)
    except FileExistsError:
        if path.read_bytes()!=raw: raise ValueError('trajectory_mismatch')
    gain=sum(r['candidate']-r['baseline'] for r in rows)/len(rows)
    return dict(status='complete',rows=rows,meanAccuracyGain=gain,
                trajectoryHash=trajectory_hash,trajectoryCount=len(traces),
                strictGainNoRegression=gain>0 and all(r['candidate']>=r['baseline'] for r in rows),
                interpretation='toy seed/width generalization only; no independent domain transfer',
                promote=False)

if __name__=='__main__':
    print(json.dumps(evaluate(sys.argv[1],int(sys.argv[2]))))
