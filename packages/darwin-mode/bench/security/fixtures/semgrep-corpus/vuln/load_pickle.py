import pickle
def handle(blob):
    return pickle.loads(blob)  # CWE-502 unsafe deserialization
