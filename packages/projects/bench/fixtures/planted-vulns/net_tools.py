import os
from flask import request

def ping():
    host = request.args.get("host")
    os.system("ping -c 1 " + host)      # CWE-78: user input concatenated into a shell command
