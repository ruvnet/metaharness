"""Opt-in scientific-dependency tests: python3 examples/learning_checks.py."""
import unittest
import numpy as np
from tabular_learning import data, train

class LearningChecks(unittest.TestCase):
    def test_splits_are_disjoint_and_cover_data(self):
        for family in ('digits','wine'):
            X,y,tr,dev,test=data(family)
            self.assertEqual(len(set(tr)|set(dev)|set(test)),len(y))
            self.assertFalse(set(tr)&set(dev) or set(tr)&set(test) or set(dev)&set(test))
            np.testing.assert_allclose(X[tr,:-1].mean(axis=0),0,atol=1e-12)

    def test_held_out_labels_cannot_change_training(self):
        for family in ('digits','wine'):
            X,y,tr,dev,test=data(family)
            changed=y.copy()
            changed[np.r_[dev,test]]=np.roll(changed[np.r_[dev,test]],1)
            a,ta=train(X,y,tr,19,.6)
            b,tb=train(X,changed,tr,19,.6)
            np.testing.assert_array_equal(a,b)
            self.assertEqual(ta,tb)
            self.assertEqual(len(ta),64)
            self.assertTrue(all(len(r['trainingIds'])==64 for r in ta))
            self.assertTrue(all(set(r['trainingIds'])<=set(tr) for r in ta))

    def test_single_step_matches_independent_gradient(self):
        X=np.array([[1.,0.,1.],[0.,1.,1.],[-1.,1.,1.]])
        y=np.array([0,1,1]); ids=np.arange(3)
        W,trace=train(X,y,ids,19,.5,updates=1,batch_size=4,rate=.1)
        sampled=trace[0]['trainingIds']
        residual=np.full((4,2),.5)
        residual[np.arange(4),y[sampled]]-=1
        np.testing.assert_allclose(W,-.1*X[sampled].T@residual/4)

if __name__=='__main__': unittest.main()
