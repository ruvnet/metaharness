import yaml
def handle(d): return yaml.safe_load(d)     # fixed CWE-502
