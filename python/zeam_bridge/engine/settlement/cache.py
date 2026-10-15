import json
import os
import threading
import time

from ..files import atomic_write, locked, read_json


class Cache:

    def get(self, key):
        raise NotImplementedError

    def set(self, key, value, ttl_seconds):
        raise NotImplementedError


class ArrayCache(Cache):
    def __init__(self, clock=None):
        self._items = {}
        self._clock = clock
        self._lock = threading.Lock()

    def _now(self):
        return float(self._clock()) if self._clock else time.time() * 1000

    def get(self, key):
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            value, until = item
            if until < self._now():
                del self._items[key]
                return None
            return value

    def set(self, key, value, ttl_seconds):
        with self._lock:
            self._items[key] = (value, self._now() + 1000 * float(ttl_seconds))


class FileCache(Cache):

    def __init__(self, path, clock=None):
        self.path = path
        self._clock = clock
        self._lock = threading.Lock()
        had = read_json(path)
        self._items = had if isinstance(had, dict) else {}

    def _now(self):
        return float(self._clock()) if self._clock else time.time() * 1000

    def get(self, key):
        with self._lock:
            item = self._items.get(key)
            if not isinstance(item, list) or len(item) != 2:
                return None
            value, until = item
            if not isinstance(until, (int, float)) or until < self._now():
                self._items.pop(key, None)
                return None
            return value

    def set(self, key, value, ttl_seconds):
        with self._lock:
            entry = [value, self._now() + 1000 * float(ttl_seconds)]
            self._items[key] = entry
            try:
                os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
                with locked(self.path + ".lock"):
                    had = read_json(self.path)
                    items = had if isinstance(had, dict) else {}
                    now = self._now()
                    items = {k: v for k, v in items.items() if isinstance(v, list) and len(v) == 2 and isinstance(v[1], (int, float)) and v[1] >= now}
                    items[key] = entry
                    atomic_write(self.path, json.dumps(items, separators=(",", ":")))
                    self._items = items
            except OSError:
                pass

