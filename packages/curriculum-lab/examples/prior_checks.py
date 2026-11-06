"""Independent serialized-tree inference, checkpoint replay, and leakage checks."""
import json,sys,unittest
from pathlib import Path
import numpy as np
from learned_prior import features,new_data,FAMILIES,GRID
class PriorChecks(unittest.TestCase):
    def test_features_ignore_heldout_data_and_labels(self):
        for f in FAMILIES:
            X,y,tr,dv,te=new_data(f,41001);a=features(X,y,tr)
            changed=X.copy();changed[np.r_[dv,te]]=12345;labels=y.copy();labels[np.r_[dv,te]]=99
            self.assertEqual(a,features(changed,labels,tr))
    def test_new_data_partitions_are_disjoint(self):
        for f in FAMILIES:
            X,y,tr,dv,te=new_data(f,41001)
            self.assertEqual(len(set(tr)|set(dv)|set(te)),1200)
            self.assertFalse(set(tr)&set(dv) or set(tr)&set(te) or set(dv)&set(te))
            np.testing.assert_allclose(X[tr,:-1].mean(0),0,atol=1e-12)
def tree_predict(tree,vector):
    node=0;vector=np.array(vector,dtype=np.float32)
    while tree['children_left'][node]!=-1:
        node=tree['children_left'][node] if vector[tree['feature'][node]]<=tree['threshold'][node] else tree['children_right'][node]
    return tree['value'][node]
def replay(directory):
    root=Path(directory);report=json.loads((root/'report.json').read_text());forest=json.loads((root/'prior-forest.json').read_text());records={};fits=predictions=0
    data={}
    for p in root.glob('*.evaluation.json'):
        r=json.loads(p.read_text());key=(r['family'],r['seed'])
        if key not in data:data[key]=new_data(*key)
        X,y,tr,dv,te=data[key];target=dv if r['phase']=='discovery' else te
        assert r['targetIds']==target.tolist();scores=[]
        expected=[907,911] if r['phase']=='discovery' else [1009,1013,1019,1021]
        assert [x['seed'] for x in r['records']]==expected
        for row in r['records']:
            pred=(X[target]@np.array(row['checkpoint'])).argmax(1);assert pred.tolist()==row['prediction']
            score=np.mean([np.mean(pred[y[target]==c]==c) for c in np.unique(y[target])]);assert abs(score-row['score'])<1e-14;scores.append(score)
            assert len(row['trace'])==64 and all(len(s['trainingIds'])==64 and set(s['trainingIds'])<=set(tr) for s in row['trace'])
            fits+=1;predictions+=len(pred)
        assert abs(np.mean(scores)-r['mean'])<1e-14
        records[r['family'],r['seed'],r['phase'],r['rate']]=r
    for r in report['results']:
        predicted=[np.mean([tree_predict(t,r['feature']+[float(np.log(rate))]) for t in forest]) for rate in GRID]
        np.testing.assert_allclose(predicted,r['estimatedGridGains'],atol=1e-14,rtol=0)
        ranked=sorted(range(7),key=lambda i:(-predicted[i],i));assert r['arms']['learned']==[GRID[i] for i in ranked[:2]]
        for arm,items in r['discovery'].items():
            assert len(items)==(7 if arm in ['grid','random_full'] else 2)
            for v in items:assert v['score']==records[r['family'],r['seed'],'discovery',v['rate']]['mean']
            assert r['chosen'][arm]==sorted(items,key=lambda x:-x['score'])[0]['rate']
            assert r['confirmation'][arm]==records[r['family'],r['seed'],'confirmation',r['chosen'][arm]]['mean']
    for c in report['comparisons']:
        ds=np.array([np.mean([r['confirmation']['learned']-r['confirmation'][c['control']] for r in report['results'] if r['seed']==s]) for s in range(41001,41801,100)])
        assert abs(ds.mean()-c['gain'])<1e-14
        assert abs(ds.mean()-2.365*ds.std(ddof=1)/np.sqrt(8)-c['lower95'])<1e-14
    assert fits==report['executedFits']
    return dict(status='PASS',verifiedFits=fits,verifiedPredictions=predictions,verifiedPriorPredictions=len(report['results'])*7,verifiedEvaluations=len(records),trainingTraceSteps=fits*64)
if __name__=='__main__':
    if len(sys.argv)==2:print(json.dumps(replay(sys.argv[1])))
    else:unittest.main()
