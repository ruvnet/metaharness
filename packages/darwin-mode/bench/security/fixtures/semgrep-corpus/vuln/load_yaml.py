import yaml
def handle(data):
    return yaml.load(data)  # CWE-502 unsafe deserialization
