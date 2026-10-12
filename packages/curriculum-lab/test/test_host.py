import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

BASE=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name,BASE/'examples'/(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
loader=module('ruos_secret')
runner=module('runner')

class HostTests(unittest.TestCase):
    def test_loader_scopes_and_never_executes_shell(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'binding';p.write_text("export HF_TOKEN='test-hf'\nVAST_API_KEY='$(false)'\nNPM_TOKEN='irrelevant'\n")
            p.chmod(0o600)
            self.assertEqual(loader.load_bound_secret('HF_TOKEN',p),'test-hf')
            self.assertEqual(loader.load_bound_secret('VAST_API_KEY',p),'$(false)')
            with self.assertRaises(ValueError):loader.load_bound_secret('NPM_TOKEN',p)
            p.chmod(0o644)
            with self.assertRaises(ValueError):loader.load_bound_secret('HF_TOKEN',p)
    def test_loader_rejects_symlink_and_duplicate(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'binding';p.write_text('HF_TOKEN=x\nHF_TOKEN=y\n');p.chmod(0o600)
            with self.assertRaises(ValueError):loader.load_bound_secret('HF_TOKEN',p)
            link=Path(d)/'link';link.symlink_to(p)
            with self.assertRaises(OSError):loader.load_bound_secret('HF_TOKEN',link)
    def prepare(self, root, trainer):
        (root/'manifests').mkdir();(root/'trainer.py').write_text(trainer)
        manifest={'trainerHash':hashlib.sha256(trainer.encode()).hexdigest(),'maxSeconds':10,'trainingSpec':{'scope':'synthetic'}}
        data=json.dumps(manifest).encode();key=hashlib.sha256(data).hexdigest()
        (root/'manifests'/(key+'.json')).write_bytes(data)
        return key
    def test_real_cpu_training_through_runner_and_receipt_reuse(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);key=self.prepare(root,(BASE/'examples/local_learning.py').read_text())
            result=runner.run(root,key)
            self.assertEqual(result['state'],'COMPLETED_UNREVIEWED')
            artifact=json.loads((root/'receipts'/(key+'.trainer.json')).read_text())
            self.assertEqual(artifact['rsiVerdict'],'NOT_ESTABLISHED')
            self.assertEqual(len(artifact['rows']),3)
            self.assertTrue(all(r['fixedWeights'] != [0,0] for r in artifact['rows']))
            self.assertEqual(runner.run(root,key)['state'],'REUSED')
    def test_child_receives_no_inherited_tokens(self):
        with tempfile.TemporaryDirectory() as d:
            source="import os,sys,json\nfrom pathlib import Path\nassert 'HF_TOKEN' not in os.environ\nassert 'VAST_API_KEY' not in os.environ\nPath(sys.argv[2]).write_text(json.dumps({'ok':True}))\n"
            root=Path(d);key=self.prepare(root,source)
            old=os.environ.get('HF_TOKEN');os.environ['HF_TOKEN']='test-secret'
            try:self.assertEqual(runner.run(root,key)['exitCode'],0)
            finally:
                if old is None:os.environ.pop('HF_TOKEN',None)
                else:os.environ['HF_TOKEN']=old
    def test_mutated_trainer_and_uncertain_intent_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);key=self.prepare(root,'pass\n')
            (root/'trainer.py').write_text('print("changed")')
            with self.assertRaises(ValueError):runner.run(root,key)
            (root/'trainer.py').write_text('pass\n')
            (root/'receipts').mkdir();(root/'receipts'/(key+'.intent')).write_text(key)
            self.assertEqual(runner.run(root,key)['state'],'HOLD')

if __name__=='__main__':unittest.main()
