import yaml
def handle(data):
    return yaml.safe_load(data)  # safe API — must NOT be flagged
