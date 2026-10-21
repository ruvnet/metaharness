"""Independent numerical replay and fixed-budget verification for policy search."""
import json,sys,unittest
from pathlib import Path
import numpy as np
from policy_worker import dataset,CONFIGS
from tabular_learning import train
class PolicyChecks(unittest.TestCase):
    def test_partitions_and_preprocessing(self):
        for f in CONFIGS:
            X,y,tr,dv,te=dataset(f,32001)
            self.assertEqual(len(set(tr)|set(dv)|set(te)),1200)
            self.assertFalse(set(tr)&set(dv) or set(tr)&set(te) or set(dv)&set(te))
            np.testing.assert_allclose(X[tr,:-1].mean(0),0,atol=1e-12)
    def test_no_confirmation_label_training(self):
        for f in CONFIGS:
            X,y,tr,dv,te=dataset(f,32001);other=y.copy();other[np.r_[dv,te]]=np.roll(other[np.r_[dv,te]],5)
            a,ta=train(X,y,tr,701,.5,rate=.4);b,tb=train(X,other,tr,701,.5,rate=.4)
            np.testing.assert_array_equal(a,b);self.assertEqual(ta,tb)
def replay(directory):
    root=Path(directory);report=json.loads((root/'report.json').read_text());evaluated={};fits=predictions=0
    for p in (root/'evaluations').glob('*.json'):
        if p.name.endswith('.intent.json'):continue
        r=json.loads(p.read_text())['receipt'];q=r['request'];evaluated[q['split'],q['phase'],q['rate']]=r
        assert q['seeds']==([701,709] if q['phase']=='discovery' else [809,811,821,823])
        means={f:[] for f in CONFIGS}
        for row in r['rows']:
            X,y,tr,dv,te=dataset(row['family'],q['split']);target=dv if q['phase']=='discovery' else te
            assert target.tolist()==row['targetIds'];pred=(X[target]@np.array(row['checkpoint'])).argmax(1)
            assert pred.tolist()==row['prediction'];score=np.mean([np.mean(pred[y[target]==c]==c) for c in np.unique(y[target])])
            assert abs(score-row['balancedAccuracy'])<1e-14
            assert len(row['trace'])==64 and all(len(s['trainingIds'])==64 and set(s['trainingIds'])<=set(tr) for s in row['trace'])
            means[row['family']].append(score);fits+=1;predictions+=len(pred)
        assert all(abs(np.mean(means[f])-r['familyMeans'][f])<1e-14 for f in CONFIGS)
        assert abs(np.mean(list(r['familyMeans'].values()))-r['primary'])<1e-14
    for row in report['rows']:
        union=set()
        for arm,s in row['searches'].items():
            rates={c['rate'] for c in s['candidates']};assert len(rates)==7 and .4 in rates;union|=rates
            for c in s['candidates']:assert c['primary']==evaluated[row['split'],'discovery',c['rate']]['primary']
            assert s['winner']['primary']==max(c['primary'] for c in s['candidates'])
            assert row['rates'][arm]==s['winner']['rate']
        assert union=={k[2] for k in evaluated if k[:2]==(row['split'],'discovery')}
        for arm,rate in row['rates'].items():assert row['confirmation'][arm]['primary']==evaluated[row['split'],'confirmation',rate]['primary']
        assert row['discoveryFitsPerSearch']==28 and row['confirmationFitsPerArm']==8
    for comp in report['comparisons']:
        d=np.array([r['confirmation']['candidate']['primary']-r['confirmation'][comp['control']]['primary'] for r in report['rows']]);lower=d.mean()-2.365*d.std(ddof=1)/np.sqrt(8)
        assert abs(d.mean()-comp['gain'])<1e-14 and abs(lower-comp['lower95'])<1e-14
    return dict(status='PASS',verifiedEvaluations=len(evaluated),verifiedFits=fits,verifiedPredictions=predictions,trainingTraceSteps=fits*64)
if __name__=='__main__':
    if len(sys.argv)==2:print(json.dumps(replay(sys.argv[1])))
    else:unittest.main()
