"""Learn a bounded rate prior from historical discovery receipts; sealed-family test.
No pickle loading, providers, policy promotion, or evaluator modification.
"""
import hashlib,json,sys,time
from pathlib import Path
import numpy as np
import sklearn
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.datasets import make_moons,make_blobs
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import balanced_accuracy_score
from tabular_learning import train,digest
from optimizer_worker import dataset as public_data
from policy_worker import dataset as synthetic_data
GRID=[float(x) for x in np.geomspace(.05,1,7)]
FAMILIES=['moons_nuisance','anisotropic_blobs']

def features(X,y,tr):
    A=X[tr,:-1];labels=y[tr];classes=np.unique(labels)
    centers=np.array([A[labels==c].mean(0) for c in classes])
    counts=np.array([np.sum(labels==c) for c in classes]);dist=((A[:,None,:]-centers[None,:,:])**2).sum(2)
    nearest=classes[dist.argmin(1)];centroid=float(np.mean([np.mean(nearest[labels==c]==c) for c in classes]))
    within=float(np.mean((A-centers[np.searchsorted(classes,labels)])**2));between=float(np.mean(centers**2))
    return [float(np.log(len(tr))),float(np.log(A.shape[1])),float(len(classes)),float(counts.min()/counts.max()),centroid,within,between]

def new_data(family,seed):
    rng=np.random.default_rng(seed)
    if family=='moons_nuisance':
        raw,y=make_moons(n_samples=1200,noise=.25,random_state=seed)
        raw=np.column_stack([raw,rng.normal(size=(1200,8))])
    elif family=='anisotropic_blobs':
        raw,y=make_blobs(n_samples=1200,n_features=12,centers=4,cluster_std=5.,random_state=seed)
        transform=rng.normal(size=(12,12))/np.sqrt(12);raw=raw@transform
        raw=np.column_stack([raw,rng.normal(size=(1200,8))]);flip=rng.random(1200)<.03;y[flip]=rng.integers(0,4,flip.sum())
    else:raise ValueError('family')
    ids=np.arange(len(y));tr,rest=train_test_split(ids,test_size=.4,stratify=y,random_state=seed+1)
    dv,te=train_test_split(rest,test_size=.5,stratify=y[rest],random_state=seed+2)
    X=StandardScaler().fit(raw[tr]).transform(raw)
    return np.column_stack([X,np.ones(len(X))]),y,tr,dv,te

def history(paths):
    observations=[];source_hashes={};cache={}
    for root in map(Path,paths):
        loader=public_data if root.name=='optimizer-comparison-v1' else synthetic_data
        for p in sorted((root/'evaluations').glob('*.json')):
            if p.name.endswith('.intent.json'):continue
            record=json.loads(p.read_text())['receipt'];q=record['request']
            if q['phase']!='discovery':continue
            source_hashes[str(root.name+'/'+p.name)]=hashlib.sha256(p.read_bytes()).hexdigest()
            for family,score in record['familyMeans'].items():
                key=(root.name,family,q['split'])
                if key not in cache:
                    X,y,tr,_,_=loader(family,q['split']);cache[key]=features(X,y,tr)
                observations.append(dict(task=list(key),features=cache[key],rate=q['rate'],score=score))
    anchors={tuple(r['task']):r['score'] for r in observations if r['rate']==.4}
    for r in observations:r['target']=r['score']-anchors[tuple(r['task'])]
    return observations,source_hashes

def fit_prior(rows):
    X=np.array([r['features']+[float(np.log(r['rate']))] for r in rows]);y=np.array([r['target'] for r in rows])
    model=ExtraTreesRegressor(n_estimators=64,min_samples_leaf=5,max_features=1.,random_state=49001,n_jobs=1)
    model.fit(X,y);return model

def rank(model,feature):
    pred=model.predict(np.array([feature+[float(np.log(rate))] for rate in GRID]))
    order=sorted(range(7),key=lambda i:(-pred[i],i))
    return [GRID[i] for i in order],pred.tolist()

def write_once(path,value):
    encoded=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n'
    if path.exists():
        if path.read_text()!=encoded:raise ValueError('immutable_file_changed')
    else:
        with path.open('x') as f:f.write(encoded)

def run(directory,paths):
    root=Path(directory);root.mkdir(parents=True,exist_ok=True);start=time.perf_counter()
    rows,hashes=history(paths);seeds=list(range(41001,41801,100))
    source={n:hashlib.sha256((Path(__file__).parent/n).read_bytes()).hexdigest() for n in ['learned_prior.py','tabular_learning.py','optimizer_worker.py','policy_worker.py']}
    plan=dict(schema=1,sources=source,historyHashes=hashes,trainingRows=len(rows),trainingTasks=len({tuple(r['task']) for r in rows}),features='train-only size/dimensions/classes/imbalance/nearest-centroid accuracy/within and between variance plus log learning rate',model='ExtraTreesRegressor(64 trees,min_samples_leaf=5,max_features=1,random_state=49001,n_jobs=1)',grid=GRID,seeds=seeds,families=FAMILIES,discoverySeeds=[907,911],confirmationSeeds=[1009,1013,1019,1021],updates=64,batchSize=64,hardFraction=.5,arms={'learned':2,'fixed_pair':2,'random_pair':2,'grid':7,'random_full':7},fixedPair=[.05,.4],acceptance='Learned must be noninferior to seven-candidate grid and random_full: mean and paired seed 95% lower bound >= -0.005, each family mean >= -0.005. Must also beat fixed_pair and random_pair: mean >=0.005, lower95>0, no family regression. >=50% fit-work saving vs full searches including confirmation; charge historical training and prior fit separately. All eight population seeds retained.',limits='Resource-ablation experiment with a genuinely fitted regression prior, not a Darwin engine execution or LLM training. Two synthetic task generators; no claim of general RSI. Sources and all history hashes frozen before prior fitting and confirmation outcomes.',externalCalls=0,promote=False)
    write_once(root/'frozen.json',plan)
    if (root/'report.json').exists():
        saved=json.loads((root/'report.json').read_text());assert saved['planHash']==digest(plan)
        print(json.dumps(dict(decision=saved['decision'],reused=True,newFits=0)));return
    # A partial run is reconciled explicitly rather than silently retrained.
    lock=root/'run.intent.json'
    if lock.exists():raise ValueError('unfinished_run_requires_reconciliation')
    write_once(lock,dict(planHash=digest(plan)));write_once(root/'training-table.json',rows)
    t=time.perf_counter();model=fit_prior(rows);prior_seconds=time.perf_counter()-t
    forest=[dict(children_left=t.tree_.children_left.tolist(),children_right=t.tree_.children_right.tolist(),feature=t.tree_.feature.tolist(),threshold=t.tree_.threshold.tolist(),value=t.tree_.value[:,0,0].tolist()) for t in model.estimators_]
    write_once(root/'prior-forest.json',forest)
    evaluations={};results=[];fits=0;fit_seconds=0
    for seed in seeds:
        for family in FAMILIES:
            X,y,tr,dv,te=new_data(family,seed);feature=features(X,y,tr);rates,estimated=rank(model,feature)
            rng=np.random.default_rng(seed+(0 if family==FAMILIES[0] else 50000))
            random=[.4]+[float(v) for v in np.exp(rng.uniform(np.log(.05),0,6))]
            arms=dict(learned=rates[:2],fixed_pair=[.05,.4],random_pair=random[:2],grid=GRID,random_full=random)
            data_hash=digest([X.tolist(),y.tolist(),tr.tolist(),dv.tolist(),te.tolist()])
            def evaluate(rate,phase):
                nonlocal fits,fit_seconds
                key=digest(dict(seed=seed,family=family,rate=rate,phase=phase))
                if key in evaluations:return evaluations[key]
                if time.perf_counter()-start>300:raise ValueError('time_budget')
                target=dv if phase=='discovery' else te;fitseeds=plan['discoverySeeds'] if phase=='discovery' else plan['confirmationSeeds'];records=[]
                for fs in fitseeds:
                    begin=time.perf_counter();W,trace=train(X,y,tr,fs,.5,rate=rate);fit_seconds+=time.perf_counter()-begin;fits+=1
                    pred=np.argmax(X[target]@W,1)
                    records.append(dict(seed=fs,score=float(balanced_accuracy_score(y[target],pred)),prediction=pred.tolist(),checkpoint=W.tolist(),trace=trace))
                receipt=dict(seed=seed,family=family,rate=rate,phase=phase,dataHash=data_hash,targetIds=target.tolist(),records=records,mean=float(np.mean([r['score'] for r in records])))
                write_once(root/(key+'.evaluation.json'),receipt);evaluations[key]=receipt;return receipt
            discovery={a:[dict(rate=r,score=evaluate(r,'discovery')['mean']) for r in rs] for a,rs in arms.items()}
            chosen={a:sorted(rs,key=lambda x:-x['score'])[0]['rate'] for a,rs in discovery.items()}
            confirmation={a:evaluate(r,'confirmation')['mean'] for a,r in chosen.items()}
            results.append(dict(seed=seed,family=family,feature=feature,estimatedGridGains=estimated,rankedRates=rates,arms=arms,discovery=discovery,chosen=chosen,confirmation=confirmation,dataHash=data_hash))
    comparisons=[]
    for control in ['grid','random_full','fixed_pair','random_pair']:
        deltas=np.array([np.mean([r['confirmation']['learned']-r['confirmation'][control] for r in results if r['seed']==s]) for s in seeds]);gain=float(deltas.mean());lower=float(gain-2.365*deltas.std(ddof=1)/np.sqrt(8));family_gains={f:float(np.mean([r['confirmation']['learned']-r['confirmation'][control] for r in results if r['family']==f])) for f in FAMILIES}
        full=control in ['grid','random_full'];passed=gain>=(-.005 if full else .005) and lower>=(-.005 if full else 0) and min(family_gains.values())>=(-.005 if full else 0)
        comparisons.append(dict(control=control,gain=gain,lower95=lower,familyGains=family_gains,passGate=bool(passed)))
    report=dict(planHash=digest(plan),trainingRows=len(rows),trainingTasks=plan['trainingTasks'],results=results,comparisons=comparisons,decision='MEASURED_PRIOR_EFFICIENCY_GAIN' if all(r['passGate'] for r in comparisons) else 'HOLD_NO_CONFIRMED_PRIOR_GAIN',fitWorkPerTask={'learned':8,'fixed_pair':8,'random_pair':8,'grid':18,'random_full':18},nominalFitWorkSaving=1-8/18,executedFits=fits,executedEvaluations=len(evaluations),priorFitSeconds=prior_seconds,totalFitSeconds=fit_seconds,seconds=time.perf_counter()-start,externalCalls=0,providerCostUsd=0,historicalCost='Historical fits and infrastructure costs are sunk inputs, not free learning; no net amortization claimed.',signed=False,promote=False,rsi='NOT_ESTABLISHED',limits=plan['limits'])
    write_once(root/'report.json',report);print(json.dumps({k:v for k,v in report.items() if k!='results'}))
if __name__=='__main__':run(sys.argv[1],sys.argv[2:])
