"""Persistent, credential-free local evaluator for the frozen optimizer comparison."""
import json, sys, time
from pathlib import Path
import numpy as np
import sklearn
from sklearn.datasets import load_digits, load_wine, load_breast_cancer
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import balanced_accuracy_score
from tabular_learning import train, digest

FAMILIES={'digits':load_digits,'wine':load_wine,'breast_cancer':load_breast_cancer}
CACHE={}
def dataset(family, split):
    key=(family,split)
    if key not in CACHE:
        ds=FAMILIES[family](); ids=np.arange(len(ds.target))
        tr,rest=train_test_split(ids,test_size=.4,random_state=split,stratify=ds.target)
        dv,te=train_test_split(rest,test_size=.5,random_state=split+1,stratify=ds.target[rest])
        X=StandardScaler().fit(ds.data[tr]).transform(ds.data)
        CACHE[key]=(np.column_stack([X,np.ones(len(X))]),ds.target,tr,dv,te)
    return CACHE[key]
def manifest(splits):
    rows=[]
    for split in splits:
        for family in FAMILIES:
            X,y,tr,dv,te=dataset(family,split)
            rows.append(dict(split=split,family=family,dataHash=digest([X.tolist(),y.tolist()]),trainHash=digest(tr.tolist()),discoveryHash=digest(dv.tolist()),confirmationHash=digest(te.tolist())))
    return dict(rows=rows,numpy=np.__version__,sklearn=sklearn.__version__)
def evaluate(r):
    if r['phase'] not in ('discovery','confirmation'): raise ValueError('phase')
    if not .05<=r['rate']<=1: raise ValueError('rate')
    rows=[]; start=time.perf_counter()
    for family in FAMILIES:
        X,y,tr,dv,te=dataset(family,r['split'])
        target=dv if r['phase']=='discovery' else te
        for seed in r['seeds']:
            W,trace=train(X,y,tr,seed,.5,rate=r['rate'])
            pred=np.argmax(X[target]@W,axis=1)
            rows.append(dict(family=family,seed=seed,balancedAccuracy=float(balanced_accuracy_score(y[target],pred)),targetIds=target.tolist(),prediction=pred.tolist(),checkpoint=W.tolist(),trace=trace))
    means={f:float(np.mean([x['balancedAccuracy'] for x in rows if x['family']==f])) for f in FAMILIES}
    result=dict(request=r,rows=rows,familyMeans=means,primary=float(np.mean(list(means.values()))),seconds=time.perf_counter()-start)
    return result
if __name__=='__main__':
    for line in sys.stdin:
        try:
            r=json.loads(line)
            result=manifest(r['splits']) if r.get('op')=='manifest' else evaluate(r)
            print(json.dumps(result,allow_nan=False),flush=True)
        except Exception as e:
            print(json.dumps({'error':type(e).__name__+':'+str(e)}),flush=True)
