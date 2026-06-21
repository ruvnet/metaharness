def run(a, b):
    return [1, 2, 3][a]  # CWE-125 out-of-bounds when |a| > 2
