"""Host-only loader. Returns one key in process; never print its result or source file.
Call only in a reviewed host adapter, never in candidate training code.
"""
import os
import shlex
import stat


def load_bound_secret(name, path='/run/user/1000/ruos-env'):
    if name not in {'HF_TOKEN', 'VAST_API_KEY'}:
        raise ValueError('secret_not_allowlisted')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('unsafe_secret_binding')
        raw = os.read(fd, 65537).decode()
    finally:
        os.close(fd)
    values=[]
    for line in raw.splitlines():
        stripped=line.strip()
        if stripped.startswith('export '): stripped=stripped[7:].lstrip()
        if not stripped.startswith(name+'='): continue
        # Parse shell quoting as data; no shell, expansions, commands or source/eval.
        fields=shlex.split(stripped,comments=False,posix=True)
        if len(fields)!=1 or not fields[0].startswith(name+'='):
            raise ValueError('invalid_secret_binding')
        value=fields[0].split('=',1)[1]
        if not value or any(c in value for c in '\r\n\x00'):
            raise ValueError('invalid_secret_value')
        values.append(value)
    if len(values)!=1:
        raise ValueError('missing_or_duplicate_secret')
    return values[0]
