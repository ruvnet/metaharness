import pickle
from flask import request

def load_state():
    return pickle.loads(request.data)   # CWE-502: deserializing attacker-controlled bytes
