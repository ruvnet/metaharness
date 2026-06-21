import hashlib
def handle(b): return hashlib.md5(b).hexdigest()   # CWE-327
