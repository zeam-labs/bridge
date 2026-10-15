import contextlib
import json
import os
import secrets
import threading

try:
    import fcntl
except ImportError:
    fcntl = None

_local_locks = {}
_local_guard = threading.Lock()


def ensure_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _thread_lock(path):
    with _local_guard:
        return _local_locks.setdefault(path, threading.Lock())


@contextlib.contextmanager
def locked(path, blocking=True):
    lock = _thread_lock(path)
    if not lock.acquire(blocking):
        yield False
        return
    try:
        if fcntl is None:
            yield True
            return
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
    finally:
        lock.release()


def atomic_write(path, data, mode=0o600):
    if isinstance(data, str):
        data = data.encode("utf-8")
    tmp = f"{path}.{secrets.token_hex(6)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def read_json(path):
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
