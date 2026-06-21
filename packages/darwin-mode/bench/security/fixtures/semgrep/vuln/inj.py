# Intentionally vulnerable fixture (CWE-94 code injection) for analyzer testing.
def run(user_input):
    # Untrusted input flows into eval — a real, detectable weakness.
    return eval(user_input)
