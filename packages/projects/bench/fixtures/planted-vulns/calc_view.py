from flask import request

def calc():
    expr = request.args.get("expr")
    return eval(expr)            # CWE-94: untrusted user input -> eval (genuinely exploitable)
