"""Evaluate small pure Python repair artifacts. This is a restricted language, not a general sandbox.

The trusted parent passes only generated source and test inputs over stdin. No credentials or expected
answers enter this process. Imports, arbitrary attributes, file access and dynamic evaluation are absent.
OS resource limits bound runaway loops and output; parent also enforces a wall timeout.
"""
import ast
import json
import resource
import sys

resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))

SAFE_BUILTINS = {
    "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "sorted": sorted, "reversed": reversed, "sum": sum, "min": min, "max": max,
    "abs": abs, "all": all, "any": any, "list": list, "tuple": tuple, "dict": dict,
    "set": set, "str": str, "int": int, "float": float, "bool": bool,
    "isinstance": isinstance, "ValueError": ValueError, "TypeError": TypeError,
}
METHODS = {"append", "extend", "sort", "reverse", "get", "items", "keys", "values",
           "strip", "lower", "upper", "split", "isdigit", "startswith", "endswith",
           "add", "discard", "pop", "copy", "count", "index", "remove", "isascii", "join", "setdefault"}
NODES = {
    "Module", "FunctionDef", "arguments", "arg", "Return", "If", "For", "While",
    "Break", "Continue", "Pass", "Assign", "AnnAssign", "AugAssign", "Expr",
    "Name", "Load", "Store", "Constant", "List", "Tuple", "Dict", "Set",
    "Subscript", "Slice", "Attribute", "Call", "keyword", "IfExp", "Compare",
    "BoolOp", "BinOp", "UnaryOp", "And", "Or", "Not", "Add", "Sub", "Mult",
    "Div", "FloorDiv", "Mod", "USub", "UAdd", "Eq", "NotEq", "Lt", "LtE",
    "Gt", "GtE", "In", "NotIn", "Is", "IsNot", "ListComp", "SetComp",
    "DictComp", "GeneratorExp", "comprehension", "Try", "ExceptHandler", "Raise", "Lambda",
}


def validate(source):
    if not isinstance(source, str) or len(source) > 24000:
        raise ValueError("source size")
    tree = ast.parse(source)
    funcs = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    if "solve" not in funcs:
        raise ValueError("missing solve")
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) and not (
            isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            raise ValueError("top level statement")
    for node in ast.walk(tree):
        if type(node).__name__ not in NODES:
            raise ValueError("unsupported syntax")
        if isinstance(node, ast.Name) and (node.id.startswith("_") or node.id in {"globals", "locals", "eval", "exec", "open", "input", "getattr", "setattr", "compile", "vars", "type"}):
            raise ValueError("forbidden name")
        if isinstance(node, ast.FunctionDef) and (node.name.startswith("_") or node.decorator_list):
            raise ValueError("function declaration")
        if isinstance(node, ast.Attribute) and node.attr not in METHODS:
            raise ValueError("forbidden attribute")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                if node.func.id not in SAFE_BUILTINS and node.func.id not in funcs:
                    raise ValueError("forbidden call")
            elif not isinstance(node.func, ast.Attribute):
                raise ValueError("indirect call")
    return tree


try:
    request = json.loads(sys.stdin.read(200000))
    tree = validate(request["source"])
except Exception:
    print(json.dumps({"ok": False, "kind": "language_rejected"}))
    sys.exit(0)

try:
    scope = {"__builtins__": SAFE_BUILTINS}
    exec(compile(tree, "generated-artifact", "exec"), scope)
    results = []
    unchanged = []
    for case in request["inputs"]:
        before = json.dumps(case, sort_keys=True)
        results.append(scope["solve"](case))
        unchanged.append(json.dumps(case, sort_keys=True) == before)
    output = json.dumps({"ok": True, "results": results, "inputUnchanged": unchanged}, allow_nan=False)
    if len(output) > 100000:
        raise ValueError("output limit")
    print(output)
except Exception:
    print(json.dumps({"ok": False, "kind": "execution_failed"}))
