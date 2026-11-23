"""New synthetic populations for a bounded search-policy transfer experiment."""
import json, sys, time
import numpy as np
import sklearn
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import balanced_accuracy_score
from tabular_learning import train,digest

CONFIGS={
 'compact_noisy':dict(n_samples=1200,n_features=20,n_informative=8,n_redundant=4,n_classes=3,n_clusters_per_class=2,class_sep=.7,flip_y=.03),
 'wide_sparse':dict(n_samples=1200,n_features=80,n_informative=10,n_redundant=4,n_classes=4,n_clusters_per_class=2,class_sep=1.,flip_y=.02)}
CACHE={}
def dataset(family,seed):
    if (family,seed) not in CACHE:
        raw,y=make_classification(**CONFIGS[family],random_state=seed)
        ids=np.arange(len(y));tr,rest=train_test_split(ids,test_size=.4,stratify=y,random_state=seed+1)
        dev,test=train_test_split(rest,test_size=.5,stratify=y[rest],random_state=seed+2)
        X=StandardScaler().fit(raw[tr]).transform(raw)
        CACHE[family,seed]=(np.column_stack([X,np.ones(len(X))]),y,tr,dev,test)
    return CACHE[family,seed]
def manifest(seeds):
    rows=[]
    for seed in seeds:
        for f in CONFIGS:
            X,y,tr,dv,te=dataset(f,seed)
            rows.append(dict(family=f,seed=seed,dataHash=digest([X.tolist(),y.tolist()]),trainHash=digest(tr.tolist()),discoveryHash=digest(dv.tolist()),confirmationHash=digest(te.tolist())))
    return dict(configs=CONFIGS,rows=rows,numpy=np.__version__,sklearn=sklearn.__version__)
def evaluate(r):
    assert r['phase'] in ('discovery','confirmation') and .05<=r['rate']<=1
    rows=[];start=time.perf_counter()
    for f in CONFIGS:
        X,y,tr,dv,te=dataset(f,r['split']);target=dv if r['phase']=='discovery' else te
        for seed in r['seeds']:
            W,trace=train(X,y,tr,seed,.5,rate=r['rate']);pred=np.argmax(X[target]@W,1)
            rows.append(dict(family=f,seed=seed,balancedAccuracy=float(balanced_accuracy_score(y[target],pred)),targetIds=target.tolist(),prediction=pred.tolist(),checkpoint=W.tolist(),trace=trace))
    means={f:float(np.mean([x['balancedAccuracy'] for x in rows if x['family']==f])) for f in CONFIGS}
    return dict(request=r,rows=rows,familyMeans=means,primary=float(np.mean(list(means.values()))),seconds=time.perf_counter()-start)
if __name__=='__main__':
    for line in sys.stdin:
        try:
            r=json.loads(line);print(json.dumps(manifest(r['splits']) if r.get('op')=='manifest' else evaluate(r),allow_nan=False),flush=True)
        except Exception as e: print(json.dumps({'error':type(e).__name__+':'+str(e)}),flush=True)
