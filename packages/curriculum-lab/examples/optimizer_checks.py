"""Partition and leakage checks plus independent saved-checkpoint replay."""
import json, sys, unittest
from pathlib import Path
import numpy as np
from optimizer_worker import dataset, FAMILIES
from tabular_learning import train

class OptimizerChecks(unittest.TestCase):
    def test_new_partitions_and_training_only_preprocessing(self):
        for f in FAMILIES:
            X,y,tr,dv,te=dataset(f,28001)
            self.assertEqual(len(set(tr)|set(dv)|set(te)),len(y))
            self.assertFalse(set(tr)&set(dv) or set(tr)&set(te) or set(dv)&set(te))
            np.testing.assert_allclose(X[tr,:-1].mean(0),0,atol=1e-12)
    def test_confirmation_labels_do_not_change_weights(self):
        for f in FAMILIES:
            X,y,tr,dv,te=dataset(f,28001)
            changed=y.copy(); changed[np.r_[dv,te]]=np.roll(changed[np.r_[dv,te]],3)
            a,ta=train(X,y,tr,401,.5,rate=.4)
            b,tb=train(X,changed,tr,401,.5,rate=.4)
            np.testing.assert_array_equal(a,b); self.assertEqual(ta,tb)

def replay(directory):
    directory=Path(directory); report=json.loads((directory/'report.json').read_text())
    evaluated={}; fits=predictions=0
    for p in (directory/'evaluations').glob('*.json'):
        if p.name.endswith('.intent.json'): continue
        r=json.loads(p.read_text())['receipt']; q=r['request']
        evaluated[q['split'],q['phase'],q['rate']]=r
        assert q['seeds']==([401,409] if q['phase']=='discovery' else [503,509,521,523])
        scores={f:[] for f in FAMILIES}
        for row in r['rows']:
            X,y,tr,dv,te=dataset(row['family'],q['split'])
            target=dv if q['phase']=='discovery' else te
            assert row['targetIds']==target.tolist()
            pred=(X[target]@np.array(row['checkpoint'])).argmax(1)
            assert pred.tolist()==row['prediction']
            accuracy=np.mean([np.mean(pred[y[target]==c]==c) for c in np.unique(y[target])])
            assert abs(accuracy-row['balancedAccuracy'])<1e-14
            assert len(row['trace'])==64
            assert all(len(s['trainingIds'])==64 and set(s['trainingIds'])<=set(tr) for s in row['trace'])
            scores[row['family']].append(accuracy);fits+=1;predictions+=len(pred)
        assert all(abs(np.mean(scores[f])-r['familyMeans'][f])<1e-14 for f in FAMILIES)
        assert abs(np.mean(list(r['familyMeans'].values()))-r['primary'])<1e-14
    for row in report['rows']:
        archive=json.loads((directory/f"darwin-{row['split']}"/'archive.json').read_text())
        darwin_rates={x['variant']['genome']['learning_rate'] for x in archive}
        count=row['uniqueEvaluationsPerMethod']; assert 1<=count<=11
        assert len(darwin_rates)==count
        random_rates=row['randomPool'][:count]; assert len(set(random_rates))==count
        assert row['searchFitBudgetPerMethod']==count*6
        for arm,rate in row['rates'].items():
            actual=evaluated[row['split'],'confirmation',rate]
            assert actual['primary']==row['confirmation'][arm]['primary']
        discovery={k[2] for k in evaluated if k[:2]==(row['split'],'discovery')}
        assert set(random_rates)<=discovery
        # Union excludes the shared anchor, with optional coincidental overlap.
        assert discovery==darwin_rates|set(random_rates)
        for arm,rates in [('darwin',darwin_rates),('random',random_rates)]:
            chosen=row['rates'][arm]
            assert evaluated[row['split'],'discovery',chosen]['primary']==max(evaluated[row['split'],'discovery',rate]['primary'] for rate in rates)
    return dict(verifiedEvaluations=len(evaluated),verifiedFits=fits,verifiedPredictions=predictions,trainingTraceSteps=fits*64,status='PASS',method='Independent matrix prediction and per-class recall recomputation; complete training trace membership and fixed-budget checks')

if __name__=='__main__':
    if len(sys.argv)==2: print(json.dumps(replay(sys.argv[1])))
    else: unittest.main()
