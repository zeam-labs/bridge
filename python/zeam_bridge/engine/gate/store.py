import copy
import hashlib
import os
import re

from ..files import atomic_write, ensure_dir, locked, read_json
from .jsonx import Json


class Store:

    def get(self, key):
        raise NotImplementedError

    def update(self, key, change):
        raise NotImplementedError


class FileStore(Store):

    def __init__(self, directory):
        directory = str(directory).rstrip("/")
        if directory == "":
            raise ValueError("a file store needs a directory")
        try:
            ensure_dir(directory)
        except OSError:
            raise RuntimeError(f"cannot create {directory}")
        self.dir = directory

    def _path(self, key):
        key = str(key)
        name = re.sub(r"[^a-z0-9_.-]", "_", key.lower()) + "-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12] + ".json"
        return os.path.join(self.dir, name)

    def get(self, key):
        value = read_json(self._path(key))
        return value if isinstance(value, dict) else None

    def update(self, key, change):
        path = self._path(key)
        with locked(path + ".lock"):
            current = read_json(path)
            current = current if isinstance(current, dict) else None
            nxt, result = change(copy.deepcopy(current))
            if nxt != current or (nxt is None) != (current is None):
                atomic_write(path, Json.encode(nxt))
            return result
