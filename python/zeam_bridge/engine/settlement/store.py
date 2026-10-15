import contextlib
import glob
import hashlib
import json
import os
import re
import threading
import time

from ..files import atomic_write, ensure_dir, locked, read_json
from .jsonx import Json

_CHANNEL = re.compile(r"^0x[0-9a-f]{64}$")


class Store:

    def get(self, channel_id):
        raise NotImplementedError

    def update(self, channel_id, fn):
        raise NotImplementedError

    def list(self):
        raise NotImplementedError


class FileStore(Store):

    def __init__(self, directory):
        directory = str(directory).rstrip("/")
        if directory == "":
            raise ValueError("a file store needs a directory")
        try:
            ensure_dir(directory)
        except OSError:
            raise RuntimeError(f"cannot create the channel directory {directory}")
        self.dir = directory

    @staticmethod
    def key(channel_id):
        ident = str(channel_id).lower() if channel_id is not None else ""
        if not _CHANNEL.match(ident):
            raise ValueError("a channel id is 32 bytes of hex")
        return ident

    def _path(self, channel_id):
        return os.path.join(self.dir, FileStore.key(channel_id) + ".json")

    def get(self, channel_id):
        value = read_json(self._path(channel_id))
        return value if isinstance(value, dict) else None

    def update(self, channel_id, fn):
        path = self._path(channel_id)
        with locked(path + ".lock"):
            current = read_json(path)
            current = current if isinstance(current, dict) else None
            nxt = fn(current)
            if nxt is None:
                if os.path.exists(path):
                    os.unlink(path)
            else:
                atomic_write(path, Json.encode(nxt))
            return nxt

    def list(self):
        out = []
        for file in sorted(glob.glob(os.path.join(self.dir, "0x*.json"))):
            record = self.get(os.path.basename(file)[:-5])
            if record is not None:
                out.append(record)
        return out


class StateFile:

    def __init__(self, directory, name):
        self.path = os.path.join(ensure_dir(str(directory)), name)

    def get(self):
        return read_json(self.path)

    def set(self, value):
        atomic_write(self.path, Json.encode(value))

    def update(self, fn):
        with locked(self.path + ".lock"):
            nxt = fn(read_json(self.path))
            atomic_write(self.path, Json.encode(nxt))
            return nxt


class MppHeldMemory:

    def __init__(self):
        self._held = {}
        self._lock = threading.Lock()

    def claim(self, key, until_ms, now_ms):
        with self._lock:
            for k in [k for k, until in self._held.items() if until <= now_ms]:
                del self._held[k]
            if key in self._held:
                return False
            self._held[key] = until_ms
            return True

    def release(self, key):
        with self._lock:
            self._held.pop(key, None)

    def clear(self):
        with self._lock:
            self._held.clear()


class MppHeldFiles:

    PRUNE_EVERY_MS = 60000
    WRITING_MS = 30000
    _NAME = re.compile(r"^[0-9a-f]{64}\.json$")

    def __init__(self, directory):
        directory = str(directory).rstrip("/")
        if directory == "":
            raise ValueError("a file store needs a directory")
        self.dir = ensure_dir(directory)
        self._pruned_at = 0

    def path(self, key):
        return os.path.join(self.dir, hashlib.sha256(str(key).encode("utf-8")).hexdigest() + ".json")

    def _writing(self, path):
        try:
            return time.time() * 1000 - os.stat(path).st_mtime * 1000 < self.WRITING_MS
        except OSError:
            return False

    def claim(self, key, until_ms, now_ms):
        if now_ms - self._pruned_at > self.PRUNE_EVERY_MS:
            self._pruned_at = now_ms
            with contextlib.suppress(OSError):
                self.prune(now_ms)
        path = self.path(key)
        for _ in range(2):
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                had = read_json(path)
                if (int(had.get("until", 0)) > now_ms) if isinstance(had, dict) else self._writing(path):
                    return False
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(path)
                continue
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"key": str(key), "until": int(until_ms)}))
                f.flush()
                os.fsync(f.fileno())
            return True
        return False

    def release(self, key):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path(key))

    def _names(self):
        try:
            return [n for n in os.listdir(self.dir) if self._NAME.match(n)]
        except FileNotFoundError:
            return []

    def prune(self, now_ms):
        for n in self._names():
            path = os.path.join(self.dir, n)
            had = read_json(path)
            if (int(had.get("until", 0)) <= now_ms) if isinstance(had, dict) else not self._writing(path):
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(path)

    def clear(self):
        for n in self._names():
            with contextlib.suppress(FileNotFoundError):
                os.unlink(os.path.join(self.dir, n))
