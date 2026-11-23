"""Four concurrent HF learning lanes. Host-only token, immutable bounded pilot.
Inspired by reflection/strategy evolution; not an implementation of GEPA or DGM.
"""
import concurrent.futures,hashlib,json,os,sys,threading,time,urllib.request,urllib.error
from pathlib import Path
from ruos_secret import load_bound_secret
from agent_tasks import make_tasks,public_prompt,verify
MODEL='openai/gpt-oss-120b:groq'
BASE='Solve the task exactly as specified. Track every dependency and state change. Check constraints and arithmetic, including tie-breaking, before responding. Return only a JSON object in the required answer schema. Do not add commentary or change the task semantics.'
STRATEGIES={'direction':['forward','backward'],'representation':['table','event_log'],'audit':['constraints_first','recompute']}
def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)
def digest(x):return hashlib.sha256(canonical(x).encode()).hexdigest()
def save(p,x):
    with p.open('x') as f:f.write(canonical(x)+'\n');f.flush();os.fsync(f.fileno())
def strict_json(text):
    def unique(pairs):
        out={}
        for key,value in pairs:
            if key in out:raise ValueError('duplicate_key')
            out[key]=value
        return out
    def invalid_constant(value):raise ValueError('invalid_constant')
    return json.loads(text,object_pairs_hook=unique,parse_constant=invalid_constant)
def candidate(value,kind):
    if kind=='prompt':
        if not isinstance(value,dict) or set(value)!={'instruction'} or not isinstance(value['instruction'],str) or not 1<=len(value['instruction'])<=1400:raise ValueError('invalid_candidate')
        return BASE+'\nAdditional strategy: '+value['instruction']
    if not isinstance(value,dict) or set(value)!=set(STRATEGIES) or any(value[k] not in options for k,options in STRATEGIES.items()):raise ValueError('invalid_strategy')
    return BASE+'\nUse this planning strategy: '+{'forward':'Work forward from initial conditions.','backward':'Start from the required final conditions and trace prerequisites, then simulate forward.'}[value['direction']]+' '+{'table':'Organize intermediate dependencies and state in a table.','event_log':'Organize intermediate reasoning as an ordered event log.'}[value['representation']]+' '+{'constraints_first':'Audit feasibility, invariants and tie-breaking before final arithmetic.','recompute':'Independently recompute the resulting schedule or account state before the final answer.'}[value['audit']]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):raise ValueError('redirect_refused')
class Provider:
    def __init__(self,root,token):self.root=root;self.token=token;self.lock=threading.Lock();self.slots=threading.Semaphore(2);self.stop=threading.Event();self.calls=[];self.started=time.monotonic()
    def call(self,messages,label):
        body={'model':MODEL,'messages':messages,'max_tokens':2048,'temperature':0,'reasoning_effort':'low','response_format':{'type':'json_object'}}
        encoded=canonical(body).encode()
        if len(encoded)>24000:raise ValueError('input_cap')
        with self.slots:
            with self.lock:
                if self.stop.is_set() or len(self.calls)>=128 or time.monotonic()-self.started>240:raise ValueError('budget_or_stopped')
                idx=len(self.calls);entry={'index':idx,'label':label,'requestHash':digest(body),'reservedUsd':.01};self.calls.append(entry)
                save(self.root/f'{idx:03}.intent.json',entry)
            begin=time.monotonic();receipt={'index':idx,'label':label,'request':body,'requestHash':digest(body),'status':'INCONCLUSIVE'}
            try:
                req=urllib.request.Request('https://router.huggingface.co/v1/chat/completions',data=encoded,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
                with urllib.request.build_opener(NoRedirect()).open(req,timeout=35) as response:
                    raw=response.read(262145)
                    if len(raw)>262144:raise ValueError('response_cap')
                    data=json.loads(raw)
                c=data['choices'][0];usage=data['usage'];content=c['message'].get('content')
                receipt.update(finishReason=c.get('finish_reason'),usage=usage,model=data.get('model'),systemFingerprint=data.get('system_fingerprint'),content=content,reasoning=c['message'].get('reasoning'))
                if not isinstance(content,str) or c.get('finish_reason')!='stop':raise ValueError('incomplete_completion')
                if any(type(usage.get(k)) is not int or usage[k]<0 for k in ['prompt_tokens','completion_tokens','total_tokens']) or usage['total_tokens']!=usage['prompt_tokens']+usage['completion_tokens']:raise ValueError('invalid_usage')
                if usage['completion_tokens']>2048 or usage['prompt_tokens']>len(encoded):raise ValueError('usage_bound')
                receipt['value']=strict_json(content);receipt['status']='COMPLETE';receipt['validatedUsage']=usage
            except urllib.error.HTTPError as e:receipt['reason']='provider_http_'+str(e.code);self.stop.set()
            except Exception:receipt['reason']='invalid_or_uncertain_completion';self.stop.set()
            receipt['latencySeconds']=time.monotonic()-begin;save(self.root/f'{idx:03}.receipt.json',receipt)
            with self.lock:entry.update({k:v for k,v in receipt.items() if k not in ['request','content','reasoning','value']})
            if receipt['status']!='COMPLETE':raise ValueError('provider_inconclusive')
            return receipt

def run(directory):
    root=Path(directory);root.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(root,0o700)
    base=Path(__file__).parent;training=make_tasks('training');confirmation=make_tasks('confirmation')
    sources={n:hashlib.sha256((base/n).read_bytes()).hexdigest() for n in ['agent_experiment.py','agent_tasks.py','ruos_secret.py']}
    plan={'schema':1,'sources':sources,'model':MODEL,'servedModelRevision':None,'chatTemplateRevision':None,'requestedThinking':'low','effectiveThinkingVerified':False,'trainingHash':digest(training),'confirmationHash':digest(confirmation),'trainingTasks':len(training),'confirmationTasks':len(confirmation),'lanes':['reflection','reflection_control','strategy','strategy_control'],'rounds':2,'maxCalls':128,'plannedCalls':122,'concurrency':2,'maxOutputTokens':2048,'maxInputBytes':24000,'maxSeconds':240,'requestReservationUsd':.01,'pilotReservationCeilingUsd':1.28,'priorTaskReservationsUsd':.02,'userTaskCeilingUsd':5,'priceEstimatePerMillion':{'input':.15,'output':.75},'priceBasis':'HF model catalog checked 2026-10-12; output estimate uses higher HF catalog price, actual billing unknown','acceptance':'Complete valid calls; selected candidate gains >=2/12 confirmation tasks over baseline AND matched control; neither family regresses against either. Training-only selection. Screening only; no signed promotion or RSI claim. Ceiling-limited baseline stops before proposals.','scope':'Public synthetic tasks; reflection and allowlisted strategy configuration, not arbitrary code, actual GEPA/DGM, Arena, or LLM weight updates.'}
    p=root/'frozen.json'
    if p.exists():
        if json.loads(p.read_text())!=plan:raise ValueError('plan_changed')
    else:save(p,plan)
    if (root/'report.json').exists():
        s=json.loads((root/'report.json').read_text())
        if s['hash']!=digest(s['report']) or s['report']['planHash']!=digest(plan):raise ValueError('corrupt_receipt')
        print(canonical({'reused':True,'newCalls':0,'report':s['report']}));return
    save(root/'run.intent.json',{'planHash':digest(plan),'owner':'curriculum-lab-concurrent-hf-pilot','pid':os.getpid()})
    # Read only HF_TOKEN, keep in reviewed adapter; candidate values are data only.
    provider=Provider(root,load_bound_secret('HF_TOKEN'));baseline=[];lanes={};confirm={};decision='INCONCLUSIVE';error=None
    def solve(task,instruction,label):
        r=provider.call([{'role':'system','content':instruction},{'role':'user','content':public_prompt(task)}],label)
        check=verify(task,r['content']);return {'id':task['id'],'family':task['family'],'ok':check['ok'],'check':check,'call':r['index'],'response':r['value']}
    def evaluate(tasks,instruction,label):return [solve(t,instruction,label+':'+t['id']) for t in tasks]
    try:
        baseline=evaluate(training,BASE,'baseline:training')
        save(root/'baseline-training.json',baseline)
        if all(r['ok'] for r in baseline):decision='HOLD_BASELINE_CEILING'
        else:
            initial=[{'task':public_prompt(t),'response':r['response'],'feedback':r['check']} for t,r in zip(training,baseline)]
            def lane(name):
                kind='prompt' if name.startswith('reflection') else 'strategy';adaptive=not name.endswith('_control');history=initial;rounds=[]
                for iteration in range(2):
                    schema={'instruction':'at most 1400 characters of reusable task-solving guidance'} if kind=='prompt' else STRATEGIES
                    # All examples are training; no confirmation tasks/answers supplied.
                    request={'goal':'Propose a reusable strategy that improves task solving. Return only JSON matching the schema. Instructions cannot change task semantics or the answer schema.','schema':schema,'baseline':BASE,'trainingTraces':history,'previousCandidates':[r['candidate'] for r in rounds]}
                    proposal=provider.call([{'role':'system','content':'You improve task-solving instructions from evidence. Return a JSON object only.'},{'role':'user','content':canonical(request)}],name+':proposal:'+str(iteration))
                    value=proposal['value']
                    try:instruction=candidate(value,kind)
                    except Exception:provider.stop.set();raise
                    evaluation=evaluate(training,instruction,name+':training:'+str(iteration))
                    rounds.append({'candidate':value,'instruction':instruction,'proposalCall':proposal['index'],'training':evaluation,'score':sum(x['ok'] for x in evaluation)})
                    if adaptive:history=[{'task':public_prompt(t),'response':r['response'],'feedback':r['check']} for t,r in zip(training,evaluation)]
                selected=max(range(2),key=lambda i:rounds[i]['score']);result={'rounds':rounds,'selected':selected};save(root/(name+'.json'),result);return result
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures={name:pool.submit(lane,name) for name in plan['lanes']}
                lanes={name:f.result() for name,f in futures.items()}
            selected={'baseline':BASE,**{name:r['rounds'][r['selected']]['instruction'] for name,r in lanes.items()}}
            save(root/'selected-before-confirmation.json',{'planHash':digest(plan),'selected':selected})
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
                fs={name:pool.submit(evaluate,confirmation,text,name+':confirmation') for name,text in selected.items()};confirm={name:f.result() for name,f in fs.items()}
            decision='HOLD_NO_CONFIRMED_GAIN'
    except Exception:error='pilot_incomplete_no_retry'
    comparisons=[]
    if len(confirm)==5:
        for arm in ['reflection','strategy']:
            controls=['baseline',arm+'_control'];gains={c:sum(r['ok'] for r in confirm[arm])-sum(r['ok'] for r in confirm[c]) for c in controls}
            no_regression=all(sum(r['ok'] for r in confirm[arm] if r['family']==f)>=sum(r['ok'] for r in confirm[c] if r['family']==f) for f in {t['family'] for t in confirmation} for c in controls)
            passed=all(g>=2 for g in gains.values()) and no_regression and lanes[arm]['rounds'][lanes[arm]['selected']]['score']>sum(x['ok'] for x in baseline)
            comparisons.append({'arm':arm,'gains':gains,'noFamilyRegression':no_regression,'screeningPass':passed})
        if any(x['screeningPass'] for x in comparisons):decision='SCREENING_GAIN_REQUIRES_REPLICATION'
    usage={'prompt_tokens':0,'completion_tokens':0,'total_tokens':0}
    for r in provider.calls:
        for k in usage:usage[k]+=r.get('validatedUsage',{}).get(k,0)
    report={'planHash':digest(plan),'decision':decision,'error':error,'evaluatedTrainingTasks':len(baseline),'baselineTraining':sum(r['ok'] for r in baseline),'trainingDenominator':len(training),'confirmationScores':{a:sum(r['ok'] for r in rs) for a,rs in confirm.items()},'confirmationDenominator':len(confirmation),'comparisons':comparisons,'calls':len(provider.calls),'reservedUsd':len(provider.calls)*.01,'usage':usage,'estimatedInferenceUsd':None if any('validatedUsage' not in r for r in provider.calls) else (usage['prompt_tokens']*.15+usage['completion_tokens']*.75)/1e6,'billedUsd':None,'infrastructureCostUsd':None,'providerFailures':sum(r.get('status')!='COMPLETE' for r in provider.calls),'model':MODEL,'modelRevision':None,'effectiveThinkingVerified':False,'promote':False,'signed':False,'rsi':'NOT_ESTABLISHED','seconds':time.monotonic()-provider.started}
    save(root/'confirmation.json',confirm);save(root/'report.json',{'hash':digest(report),'report':report});print(canonical(report))
if __name__=='__main__':
    try:run(sys.argv[1])
    except Exception:print('{"status":"INCONCLUSIVE","reason":"host_or_frozen_run_blocked","retry":false}');sys.exit(1)
