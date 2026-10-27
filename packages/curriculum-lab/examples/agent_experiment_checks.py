import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from agent_experiment import Provider,candidate,strict_json,NoRedirect
class FakeResponse:
    def __init__(self,usage=None):self.usage=usage or {'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self,n):return json.dumps({'choices':[{'finish_reason':'stop','message':{'content':'{"answer":1}'}}],'usage':self.usage,'model':'fixture'}).encode()
class Checks(unittest.TestCase):
    def test_strict_json_and_strategy(self):
        for bad in ['{"a":1,"a":2}','{"a":NaN}']:
            with self.assertRaises(ValueError):strict_json(bad)
        with self.assertRaises(ValueError):candidate({'instruction':'x','command':'bad'},'prompt')
        with self.assertRaises(ValueError):candidate({'direction':'shell','representation':'table','audit':'recompute'},'strategy')
        self.assertIn('forward',candidate({'direction':'forward','representation':'table','audit':'recompute'},'strategy'))
    def test_redirect_refused(self):
        with self.assertRaises(ValueError):NoRedirect().redirect_request(None,None,302,'',{},'https://other.invalid')
    def test_durable_reservation_and_no_secret_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            p=Provider(Path(d),'fixture-secret')
            with patch('urllib.request.OpenerDirector.open',return_value=FakeResponse()):r=p.call([{'role':'user','content':'JSON'}],'fixture')
            self.assertEqual(r['status'],'COMPLETE');self.assertEqual(len(p.calls),1)
            self.assertEqual(json.loads((Path(d)/'000.intent.json').read_text())['reservedUsd'],.01)
            self.assertNotIn('fixture-secret',(Path(d)/'000.receipt.json').read_text())
    def test_invalid_accounting_stops_without_validated_usage(self):
        with tempfile.TemporaryDirectory() as d:
            p=Provider(Path(d),'fixture-secret')
            with patch('urllib.request.OpenerDirector.open',return_value=FakeResponse({'prompt_tokens':'bad','completion_tokens':5,'total_tokens':15})):
                with self.assertRaises(ValueError):p.call([{'role':'user','content':'JSON'}],'fixture')
            self.assertTrue(p.stop.is_set());self.assertNotIn('validatedUsage',p.calls[0])
            with self.assertRaises(ValueError):p.call([{'role':'user','content':'JSON'}],'fixture2')
            self.assertEqual(len(p.calls),1)
if __name__=='__main__':unittest.main()
