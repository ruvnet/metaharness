import subprocess
def handle(c): subprocess.Popen(c, shell=False)   # fixed CWE-78
