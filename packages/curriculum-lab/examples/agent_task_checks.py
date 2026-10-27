"""Independent scheduling enumeration and available-funds ledger interpreter."""
import copy
import json
import unittest
import agent_tasks as tasks


def exhaustive_slots(inp, horizon):
    jobs = inp['jobs']; occupancy = [0]*horizon; starts = {}
    def place(index):
        if index == len(jobs): return dict(starts)
        job = jobs[index]
        earliest = max([starts[k]+next(j['duration'] for j in jobs if j['id']==k) for k in job['dependencies']] or [0])
        for start in range(earliest,horizon-job['duration']+1):
            interval = range(start,start+job['duration'])
            if any(occupancy[t]+job['demand'] > inp['capacity'] for t in interval): continue
            starts[job['id']] = start
            for t in interval: occupancy[t] += job['demand']
            found = place(index+1)
            for t in interval: occupancy[t] -= job['demand']
            if found is not None: return found
            del starts[job['id']]
        return None
    return place(0)


def available_funds_reference(inp):
    free = dict(inp['balances']); held = {}; seen = []; outcomes=[]
    for tx in inp['transactions']:
        if tx['id'] in seen:
            outcomes.append('duplicate'); continue
        f,h = copy.deepcopy((free,held)); valid=True
        for op in tx['operations']:
            kind = op['op']; key=op.get('key'); amount=op.get('amount')
            if kind == 'hold':
                owner=op['account']
                if key in h or f.get(owner,-1)<amount: valid=False; break
                f[owner]-=amount;h[key]=(owner,amount)
            elif kind=='release':
                if key not in h: valid=False;break
                owner,a=h.pop(key);f[owner]+=a
            elif kind=='capture':
                if key not in h or op['to'] not in f or h[key][1]<amount:valid=False;break
                owner,a=h[key];f[op['to']]+=amount
                if a==amount:del h[key]
                else:h[key]=(owner,a-amount)
            elif kind=='transfer':
                if op['to'] not in f or f.get(op['from'],-1)<amount:valid=False;break
                f[op['from']]-=amount;f[op['to']]+=amount
        if valid:
            free,held=f,h;seen.append(tx['id']);outcomes.append('committed')
        else:outcomes.append('rejected')
    return {'balances':{a:f+sum(v for owner,v in held.values() if owner==a) for a,f in free.items()},'holds':{k:{'account':o,'amount':v} for k,(o,v) in held.items()},'outcomes':outcomes}


class Checks(unittest.TestCase):
    def test_scheduling_independent_exact_and_optimal(self):
        for split in ['training','confirmation']:
            for task in tasks.make_tasks(split):
                if task['family']!='schedule':continue
                answer=tasks.oracle(task);h=answer['makespan']
                self.assertEqual(exhaustive_slots(task['input'],h),answer['starts'])
                self.assertIsNone(exhaustive_slots(task['input'],h-1))
    def test_ledger_independent_and_conserved(self):
        for split in ['training','confirmation']:
            for task in tasks.make_tasks(split):
                if task['family']!='ledger':continue
                answer=tasks.oracle(task)
                self.assertEqual(answer,available_funds_reference(task['input']))
                self.assertEqual(sum(answer['balances'].values()),sum(task['input']['balances'].values()))
                self.assertEqual(answer['outcomes'][1:6],['rejected','committed','rejected','committed','duplicate'])
    def test_strict_verification_and_public_inputs(self):
        for split,count in [('training',6),('confirmation',12)]:
            cases=tasks.make_tasks(split);self.assertEqual(len(cases),count)
            self.assertEqual(cases,tasks.make_tasks(split))
            for case in cases:
                answer=tasks.oracle(case)
                self.assertTrue(tasks.verify(case,json.dumps(answer))['ok'])
                self.assertFalse(tasks.verify(case,{**answer,'extra':1})['ok'])
                self.assertFalse(tasks.verify(case,'```json\n'+json.dumps(answer)+'\n```')['ok'])
                self.assertNotIn('answer',case)
                self.assertIn('Input JSON:',tasks.public_prompt(case))
        task=tasks.make_tasks('training')[0];answer=tasks.oracle(task)
        answer['makespan']=float(answer['makespan'])
        self.assertFalse(tasks.verify(task,answer)['ok'])
        self.assertFalse(tasks.verify(task,'{"a":1,"a":2}')['ok'])
    def test_partition_and_no_mutation(self):
        train=tasks.make_tasks('training');confirmation=tasks.make_tasks('confirmation')
        self.assertFalse({json.dumps(x['input'],sort_keys=True) for x in train}&{json.dumps(x['input'],sort_keys=True) for x in confirmation})
        before=copy.deepcopy(train)
        for task in train:tasks.oracle(task)
        self.assertEqual(before,train)

if __name__=='__main__':unittest.main()
