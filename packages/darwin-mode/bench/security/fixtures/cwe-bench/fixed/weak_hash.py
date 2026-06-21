import hashlib
def handle(b): return hashlib.sha256(b).hexdigest()      # fixed CWE-327
