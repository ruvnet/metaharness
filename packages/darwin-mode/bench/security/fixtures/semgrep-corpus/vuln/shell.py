import subprocess
def handle(cmd):
    subprocess.Popen(cmd, shell=True)  # CWE-78 OS command injection
