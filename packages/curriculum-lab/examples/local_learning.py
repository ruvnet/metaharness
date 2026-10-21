"""Real CPU policy-weight updates, synthetic environment. NOT an LLM or RSI benchmark.
Choose one of two feasible/cheap options. Train on office labels; evaluate new
seeds with industrial labels. Names have no effect: this is deliberately a toy.
No external packages, network, model credentials, or provider cost.
"""
import argparse
from pathlib import Path
import hashlib
import json
import math
import random


def cases(seed, n, width):
    rng = random.Random(seed)
    for _ in range(n):
        # Cost difference and feasibility difference; task semantics never mutate.
        x = [rng.uniform(-width, width), rng.choice([-1, 0, 1])]
        answer = int(5 * x[1] - x[0] > 0)
        yield x, answer


def probability(w, x):
    return 1 / (1 + math.exp(-max(-30, min(30, sum(a*b for a,b in zip(w,x))))))


def train(widths, seed):
    w = [0.0, 0.0]
    rng = random.Random(seed)
    count = 0
    # REINFORCE on sampled actions with executable binary reward and baseline .5.
    for generation, width in enumerate(widths):
        for x, target in cases(seed + 100 * generation, 1200, width):
            p = probability(w, x)
            action = int(rng.random() < p)
            reward = int(action == target)
            w = [v + .04 * (reward - .5) * (action - p) * f for v,f in zip(w,x)]
            count += 1
    return w, count


def evaluate(w, seed):
    data = list(cases(seed, 1000, 4))
    correct = sum(int(probability(w,x) > .5) == target for x,target in data)
    return correct / len(data)


def main():
    rows=[]
    for seed in (7, 19, 31):
        baseline = evaluate([0, 0], seed+9000)
        fixed,n = train([4,4,4],seed)
        curriculum,m = train([1,2,4],seed)
        rows.append(dict(seed=seed, untrained=baseline, fixed=evaluate(fixed,seed+9000),
                         curriculum=evaluate(curriculum,seed+9000), updatesPerArm=n,
                         fixedWeights=fixed,curriculumWeights=curriculum))
        assert n == m
    out=dict(experiment='synthetic_cpu_policy_gradient_smoke', rows=rows,
             handAuthoredOracleAccuracy=1.0, model='two-parameter logistic policy',
             curriculum='hand-authored, not learned', externalCalls=0, providerCostUsd=0,
             rsiVerdict='NOT_ESTABLISHED', arenaTransfer='UNMEASURED', promote=False)
    out['receiptHash']=hashlib.sha256(json.dumps(out,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    parser=argparse.ArgumentParser()
    parser.add_argument("--output")
    args=parser.parse_args()
    if args.output:
        Path(args.output).write_text(json.dumps(out,indent=2))
    else:
        print(json.dumps(out,indent=2))

if __name__ == '__main__':
    main()
