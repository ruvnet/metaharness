import subprocess
def handle(c): subprocess.run(["echo", c], check=True)   # fixed CWE-78
