"""Real bounded softmax weight training on two public datasets. No model API.

Curriculum mixes uniform sampling with cached training losses. Labels from the
discovery/confirmation partitions are never used for weight updates or sampling.
This is a small-model learning experiment, not evidence about LLM reasoning.
"""
import hashlib
import json
import sys
import time
from pathlib import Path
import numpy as np
import sklearn
from sklearn.datasets import load_digits, load_wine
from sklearn.metrics import balanced_accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

def digest(x):
    return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def data(name):
    ds={'digits':load_digits,'wine':load_wine}[name]()
    ids=np.arange(len(ds.target))
    train, rest=train_test_split(ids,test_size=.4,random_state=17011,stratify=ds.target)
    dev,test=train_test_split(rest,test_size=.5,random_state=17012,stratify=ds.target[rest])
    scaler=StandardScaler().fit(ds.data[train])
    X=scaler.transform(ds.data)
    X=np.column_stack([X,np.ones(len(X))])
    return X,ds.target,train,dev,test

def manifest():
    out={}
    for name in ('digits','wine'):
        X,y,tr,dv,te=data(name)
        out[name]={'dataHash':digest({'X':X.tolist(),'y':y.tolist()}),
                   'trainHash':digest(tr.tolist()),'discoveryHash':digest(dv.tolist()),
                   'confirmationHash':digest(te.tolist()),'counts':[len(tr),len(dv),len(te)]}
    return {'numpy':np.__version__,'sklearn':sklearn.__version__,'datasets':out}

def train(X,y,indices,seed,hard_fraction,updates=64,batch_size=64,rate=.1):
    rng=np.random.default_rng(seed)
    W=np.zeros((X.shape[1],int(y.max())+1))
    cached=np.ones(len(indices))
    trace=[]
    for step in range(updates):
        weights=(1-hard_fraction)/len(indices)+hard_fraction*cached/cached.sum()
        selected=rng.choice(len(indices),size=batch_size,replace=True,p=weights)
        ids=indices[selected]
        scores=X[ids]@W
        scores-=scores.max(axis=1,keepdims=True)
        P=np.exp(scores); P/=P.sum(axis=1,keepdims=True)
        losses=-np.log(np.maximum(P[np.arange(batch_size),y[ids]],1e-12))
        cached[selected]=losses+1e-6
        D=P.copy(); D[np.arange(batch_size),y[ids]]-=1
        W-=rate*(X[ids].T@D/batch_size+.001*W)
        trace.append({'step':step,'trainingIds':ids.tolist(),'meanLoss':float(losses.mean())})
    return W,trace

def evaluate(genome,phase,directory):
    fraction=genome.get('hard_fraction',.5)
    rate=genome.get('learning_rate',.1)
    if not 0<=fraction<=1: raise ValueError('unsupported_genome')
    if not .01<=rate<=1: raise ValueError('unsupported_learning_rate')
    seeds=[11,23,37] if phase=='discovery' else [101,113,127,139,151,163,179,191,211,223]
    rows=[]; start=time.perf_counter()
    for family in ('digits','wine'):
        X,y,tr,dev,test=data(family)
        target=dev if phase=='discovery' else test
        for seed in seeds:
            W,trace=train(X,y,tr,seed,fraction,rate=rate)
            predicted=np.argmax(X[target]@W,axis=1)
            row={'family':family,'seed':seed,'balancedAccuracy':float(balanced_accuracy_score(y[target],predicted)),
                 'prediction':predicted.tolist(),'targetIds':target.tolist(),
                 'checkpoint':W.tolist(),'checkpointHash':digest(W.tolist()),'traceHash':digest(trace),
                 'updates':64,'gradientExamples':4096}
            trace_path=Path(directory)/(digest({'genome':genome,'phase':phase,'family':family,'seed':seed})+'.trace.json')
            if trace_path.exists():
                if json.loads(trace_path.read_text())!=trace: raise ValueError('trace_changed')
            else: trace_path.write_text(json.dumps(trace))
            rows.append(row)
    means={f:float(np.mean([r['balancedAccuracy'] for r in rows if r['family']==f])) for f in ('digits','wine')}
    return {'genome':genome,'phase':phase,'rows':rows,'familyMeans':means,
            'primary':float(np.mean(list(means.values()))),'seconds':time.perf_counter()-start,
            'data':manifest(),'gradientExamplesPerFit':4096,'updatesPerFit':64,
            'training':'real softmax parameter updates; no HF or LLM weights trained'}

if __name__=='__main__':
    if len(sys.argv)==2 and sys.argv[1]=='manifest': print(json.dumps(manifest()))
    else:
        request=json.load(sys.stdin)
        print(json.dumps(evaluate(request['genome'],request['phase'],request['directory'])))
