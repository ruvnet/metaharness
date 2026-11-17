#!/usr/bin/env python3
"""Development-only, bounded pure-AST oracle. Never imports/executes the upstream app.
The ten reviewed scoring helpers use arithmetic, dict/list operations and formatting.
"""
import ast, hashlib, json, random, sys
from pathlib import Path
source=Path(sys.argv[1]).read_text()
assert hashlib.sha256(source.encode()).hexdigest() == '7a4fe2629d11ed7c503971f12c4cf94d38d512864eb54dabf069a08215ee3dc4', 'Unreviewed upstream source; inspect before changing the pin'
tree=ast.parse(source)
names=['_risk_level']+['_score_'+x for x in ['military','political','conflict','infrastructure','economic','cyber','health','climate','space']]
selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(selected)==10
allowed_calls={'min','max','len','sum','sorted','isinstance','abs'}
for node in ast.walk(ast.Module(body=selected,type_ignores=[])):
    assert not isinstance(node,(ast.Import,ast.ImportFrom,ast.Global,ast.Nonlocal,ast.With,ast.AsyncWith,ast.Await,ast.Delete)),type(node)
    if isinstance(node,ast.Call):
        assert (isinstance(node.func,ast.Name) and node.func.id in allowed_calls) or (isinstance(node.func,ast.Attribute) and node.func.attr in {'get','items','append'}),ast.dump(node.func)
scope={'__builtins__':{k:__builtins__.__dict__[k] for k in allowed_calls|{'dict','list','tuple','str','float'}}}
exec(compile(ast.Module(body=selected,type_ignores=[]),'reviewed-pure-posture-helpers','exec'),scope)
rng=random.Random(170017);cases=[]
weights={'military':.18,'political':.16,'conflict':.16,'infrastructure':.10,'economic':.10,'cyber':.08,'health':.07,'climate':.08,'space':.07}
for i in range(256):
    inputs={
      'intel_military_surge':{'surge_count':rng.randrange(8),'surges':[]},
      'intel_theater_posture':{'theaters':{str(j):{'count':rng.choice([0,10,11,50])} for j in range(rng.randrange(8))}},
      'intel_instability_index':{'countries':[{'country_name':str(j),'instability_index':rng.randrange(10001)/100} for j in range(rng.randrange(10))]},
      'intel_hotspot_escalation':{'hotspots':[{'name':str(j),'score':rng.randrange(10001)/100} for j in range(rng.randrange(10))]},
      'intel_cable_health':{'corridors':{str(j):{'status_score':rng.randrange(4)} for j in range(rng.randrange(8))}},
      'intel_internet_outages':{'outage_count':rng.randrange(20)},
      'intel_shipping_index':{'stress_score':rng.randrange(10001)/100},
      'intel_cyber_threats':{'threat_count':rng.randrange(100)},
      'intel_disease_outbreaks':{'count':rng.randrange(30),'high_concern_count':rng.randrange(6)},
      'intel_climate_anomalies':{'anomalies':[{'zone':str(j),'temp_deviation_c':rng.choice([-5,-3.01,-3,0,3,3.01,5])} for j in range(rng.randrange(15))]},
      'intel_space_weather':{'current_kp':rng.randrange(901)/100}}
    args=[['military_surge','theater_posture'],['instability_index'],['hotspot_escalation'],['cable_health','internet_outages'],['shipping_index'],['cyber_threats'],['disease_outbreaks'],['climate_anomalies'],['space_weather']]
    scores={}
    for domain,keys in zip(weights,args):
        score,_=scope['_score_'+domain](*[inputs['intel_'+k] for k in keys])
        scores[domain]={'score':round(score,1),'level':scope['_risk_level'](score)}
    composite=min(100,max(0,sum(scores[k]['score']*v for k,v in weights.items())))
    cases.append({'input':inputs,'scores':scores,'composite_score':round(composite,1),'risk_level':scope['_risk_level'](composite)})
print(json.dumps({'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'selected_functions':names,'python_version':sys.version.split()[0],'seed':170017,'cases':cases},separators=(',',':')))
