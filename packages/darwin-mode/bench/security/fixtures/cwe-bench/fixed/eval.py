import ast
def handle(s): return ast.literal_eval(s)   # fixed CWE-94
