"""Frozen synthetic agent tasks. Pure data interpreters; never execute model code.

Training and confirmation use distinct seeded instances of the same task families.
This tests instance generalization, not unseen-family transfer or recursive improvement.
"""
import copy
import itertools
import json
import random

SCHEDULE_RULES = '''Schedule all jobs on a resource of capacity 2. A job consumes its demand continuously for its positive integer duration, cannot be preempted, and starts at a nonnegative integer time. Every dependency must finish before the dependent job starts. Intervals are half-open [start, start+duration), so a resource can be reused exactly at completion. Minimize the time at which all jobs finish (makespan). Among minimum-makespan schedules, choose the lexicographically smallest vector of start times in the listed job order. Return exactly {"makespan": integer, "starts": {job_id: integer, ...}}. No other keys.'''
LEDGER_RULES = '''Process transactions in order. Account balance includes reserved money; available = balance minus the sum of its active holds. Each transaction has an id and ordered operations. If that id previously COMMITTED, classify this occurrence "duplicate" and ignore all its operations. Failed transactions do not consume their id. Otherwise execute operations on a private copy and commit all only if every operation is valid; on any failure roll back the entire transaction and classify "rejected". A successful transaction is "committed". Amounts are positive integers. transfer(from,to,amount) requires available[from] >= amount and moves that amount of balance. hold(account,key,amount) requires a globally unused active hold key and sufficient available funds; it reserves funds without moving balance. release(key) requires an existing hold and deletes it. capture(key,to,amount) requires an existing hold with amount at least the capture amount; deduct balance from its owner, add balance to to, and reduce the hold amount, deleting it at zero. A released/depleted key can be reused. Unknown account or hold keys fail the operation. Return exactly {"balances": {account: integer,...}, "holds": {key: {"account": account, "amount": integer},...}, "outcomes": ["committed"|"rejected"|"duplicate", ...]}. Include every account and only active holds; include one outcome per transaction. No other keys.'''


def public_prompt(task):
    return task['instructions'] + '\nInput JSON:\n' + json.dumps(task['input'], sort_keys=True, separators=(',', ':'))


def make_tasks(split):
    if split not in ('training', 'confirmation'):
        raise ValueError('split must be training or confirmation')
    count, base = (3, 61019) if split == 'training' else (6, 92041)
    tasks = []
    for n in range(count):
        rng = random.Random(base + n * 137)
        jobs = []
        for j in range(7):
            deps = [chr(65+k) for k in range(j) if rng.random() < .22]
            jobs.append(dict(id=chr(65+j), duration=rng.randint(1, 5), demand=rng.choice([1,1,1,2]), dependencies=deps))
        tasks.append(dict(id=f'{split}-schedule-{n}', family='schedule', instructions=SCHEDULE_RULES, input={'capacity':2, 'jobs':jobs}))
        balances = dict(A=rng.randint(40,70), B=rng.randint(20,40), C=rng.randint(10,30))
        reserve = rng.randint(15,25)
        tx = [
            {'id':'t0','operations':[{'op':'hold','account':'A','key':'h0','amount':reserve}]},
            {'id':'t1','operations':[{'op':'transfer','from':'A','to':'B','amount':balances['A']-reserve+1}]},
            {'id':'t2','operations':[{'op':'capture','key':'h0','to':'C','amount':reserve-7},{'op':'hold','account':'B','key':'h1','amount':9}]},
            {'id':'t3','operations':[{'op':'release','key':'h1'},{'op':'transfer','from':'C','to':'A','amount':999}]},
            {'id':'t1','operations':[{'op':'transfer','from':'B','to':'C','amount':5}]},
            {'id':'t2','operations':[{'op':'release','key':'h0'}]},
            {'id':'t4','operations':[{'op':'capture','key':'h0','to':'B','amount':7},{'op':'hold','account':'C','key':'h0','amount':8}]},
            {'id':'t5','operations':[{'op':'capture','key':'h1','to':'A','amount':rng.randint(1,8)},{'op':'transfer','from':'A','to':'C','amount':rng.randint(1,9)}]},
            {'id':'t6','operations':[{'op':'release','key':rng.choice(['h0','h1'])},{'op':'hold','account':'A','key':'h2','amount':rng.randint(5,12)}]},
        ]
        # A seeded account permutation prevents dependence on account names.
        names = rng.sample(['ops','sales','reserve'], 3)
        mapping = dict(zip('ABC',names))
        for transaction in tx:
            for op in transaction['operations']:
                for field in ('account','from','to'):
                    if field in op: op[field] = mapping[op[field]]
        tasks.append(dict(id=f'{split}-ledger-{n}',family='ledger',instructions=LEDGER_RULES,input={'balances':{mapping[k]:v for k,v in balances.items()},'transactions':tx}))
    return tasks


def schedule_oracle(inp):
    jobs = inp['jobs']; size = len(jobs); ids = [j['id'] for j in jobs]
    dependencies = [sum(1 << ids.index(k) for k in j['dependencies']) for j in jobs]
    # Event-time exhaustive enumeration. Deliberate idling is included whenever
    # another job runs. With no releases, there is no benefit to all-idle time.
    best = None
    def search(time, done, running, starts):
        nonlocal best
        if best is not None and time > best[0]: return
        if done == (1 << size)-1:
            candidate = (time, tuple(starts))
            if best is None or candidate < best: best = candidate
            return
        active = {j for j,_ in running}
        free = inp['capacity'] - sum(jobs[j]['demand'] for j,_ in running)
        ready = [j for j in range(size) if not done >> j & 1 and j not in active and dependencies[j] & done == dependencies[j]]
        for amount in range(len(ready)+1):
            for chosen in itertools.combinations(ready, amount):
                if sum(jobs[j]['demand'] for j in chosen) > free: continue
                pending = running + [(j,time+jobs[j]['duration']) for j in chosen]
                if not pending: continue
                values = list(starts)
                for j in chosen: values[j] = time
                next_time = min(t for _,t in pending)
                finished = sum(1 << j for j,t in pending if t == next_time)
                search(next_time, done|finished, [(j,t) for j,t in pending if t != next_time], values)
    search(0,0,[],[-1]*size)
    return {'makespan':best[0], 'starts':dict(zip(ids,best[1]))}


def ledger_oracle(inp):
    balances = dict(inp['balances']); holds = {}; committed = set(); outcomes = []
    for tx in inp['transactions']:
        if tx['id'] in committed:
            outcomes.append('duplicate'); continue
        b,h = dict(balances),copy.deepcopy(holds)
        def available(account):
            return b[account] - sum(v['amount'] for v in h.values() if v['account'] == account)
        try:
            for op in tx['operations']:
                kind = op['op']
                if kind == 'transfer':
                    src,dst,a = op['from'],op['to'],op['amount']
                    if dst not in b or available(src) < a: raise ValueError()
                    b[src] -= a; b[dst] += a
                elif kind == 'hold':
                    account,key,a = op['account'],op['key'],op['amount']
                    if key in h or available(account) < a: raise ValueError()
                    h[key] = {'account':account,'amount':a}
                elif kind == 'release':
                    del h[op['key']]
                elif kind == 'capture':
                    key,dst,a = op['key'],op['to'],op['amount']; record = h[key]
                    if dst not in b or record['amount'] < a: raise ValueError()
                    b[record['account']] -= a; b[dst] += a; record['amount'] -= a
                    if record['amount'] == 0: del h[key]
                else: raise ValueError()
        except (KeyError, ValueError):
            outcomes.append('rejected'); continue
        balances,holds = b,h; committed.add(tx['id']); outcomes.append('committed')
    return dict(balances=balances,holds=holds,outcomes=outcomes)


def oracle(task):
    if task['family'] == 'schedule': return schedule_oracle(task['input'])
    if task['family'] == 'ledger': return ledger_oracle(task['input'])
    raise ValueError('unknown family')


def verify(task, response):
    """Strict JSON verification. Never repairs answers or runs candidate code."""
    try:
        if isinstance(response,str):
            def unique(pairs):
                out = {}
                for k,v in pairs:
                    if k in out: raise ValueError('duplicate key')
                    out[k] = v
                return out
            response = json.loads(response, object_pairs_hook=unique)
        expected = oracle(task)
        # JSON canonicalization distinguishes booleans/floats from integer values.
        equal = json.dumps(response,sort_keys=True,separators=(',',':'),allow_nan=False) == json.dumps(expected,sort_keys=True,separators=(',',':'))
        if equal: return {'ok':True,'error':None}
        fields = [k for k,v in expected.items() if not isinstance(response,dict) or json.dumps(response.get(k),sort_keys=True) != json.dumps(v,sort_keys=True)]
        return {'ok':False,'error':'incorrect answer','fields':fields}
    except (ValueError,TypeError):
        return {'ok':False,'error':'malformed JSON'}
