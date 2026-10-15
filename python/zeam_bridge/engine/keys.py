import base64
import os
import secrets

from Crypto.Cipher import AES
from Crypto.Protocol.KDF import scrypt

from .core import Secp256k1
from .env import setting
from .files import atomic_write, ensure_dir, locked, read_json
from .php import gmdate_iso
from .settlement.jsonx import Json

_PREFIX = "v1:"


def _wrap_key(secret, salt):
    return scrypt(secret.encode("utf-8"), salt, 32, N=2 ** 15, r=8, p=1)


def seal(plain, secret, slot):
    salt = secrets.token_bytes(16)
    cipher = AES.new(_wrap_key(secret, salt), AES.MODE_GCM, nonce=secrets.token_bytes(12))
    cipher.update(slot.encode())
    body, tag = cipher.encrypt_and_digest(plain.encode())
    return _PREFIX + base64.b64encode(salt + cipher.nonce + tag + body).decode()


def open_sealed(sealed, secret, slot):
    if not secret or not isinstance(sealed, str) or not sealed.startswith(_PREFIX):
        return None
    try:
        raw = base64.b64decode(sealed[len(_PREFIX):], validate=True)
    except ValueError:
        return None
    if len(raw) <= 44:
        return None
    salt, nonce, tag, body = raw[:16], raw[16:28], raw[28:44], raw[44:]
    try:
        cipher = AES.new(_wrap_key(secret, salt), AES.MODE_GCM, nonce=nonce)
        cipher.update(slot.encode())
        return cipher.decrypt_and_verify(body, tag).decode()
    except (ValueError, KeyError):
        return None


def new_private_key():
    for _ in range(16):
        key = "0x" + secrets.token_bytes(32).hex()
        try:
            return key, Secp256k1.private_key_to_address(key)
        except ValueError:
            continue
    raise RuntimeError("could not generate a key")


class KeyFile:

    def __init__(self, state_dir, secret=None):
        self.dir = ensure_dir(str(state_dir))
        self.path = os.path.join(self.dir, "keys.json")
        self.secret = secret if secret is not None else setting("BRIDGE_KEY_SECRET")
        self._open = {}

    def _all(self):
        value = read_json(self.path)
        return value if isinstance(value, dict) else {}

    def _write(self, records):
        atomic_write(self.path, Json.encode(records))

    def _plain(self, slot, record):
        if not isinstance(record, dict):
            return None
        if isinstance(record.get("key"), str):
            return record["key"]
        return open_sealed(record.get("sealed"), self.secret, slot)

    def _record(self, slot, key, address, created):
        record = {"address": address, "created": created}
        if self.secret:
            record["sealed"] = seal(key, self.secret, slot)
        else:
            record["key"] = key
        return record

    def get(self, slot):
        if slot in self._open:
            return self._open[slot]
        record = self._all().get(slot)
        key = self._plain(slot, record)
        if key is None:
            return None
        if self.secret and "key" in record:
            with locked(self.path + ".lock"):
                records = self._all()
                if isinstance(records.get(slot), dict) and records[slot].get("key") == key:
                    records[slot] = self._record(slot, key, record.get("address"), record.get("created"))
                    self._write(records)
        self._open[slot] = key
        return key

    def state(self, slot):
        record = self._all().get(slot)
        if not isinstance(record, dict) or ("key" not in record and "sealed" not in record):
            return "missing"
        return "ok" if self.get(slot) is not None else "locked"

    def address(self, slot):
        record = self._all().get(slot)
        return record["address"] if isinstance(record, dict) and isinstance(record.get("address"), str) else ""

    def ensure(self, slot):
        with locked(self.path + ".lock"):
            records = self._all()
            present = isinstance(records.get(slot), dict) and ("key" in records[slot] or "sealed" in records[slot])
            if not present:
                key, address = new_private_key()
                records[slot] = self._record(slot, key, address, gmdate_iso())
                self._write(records)
        return self.state(slot) == "ok"

    def put(self, slot, key):
        key = "0x" + Secp256k1.normalize_private_key(key)
        address = Secp256k1.private_key_to_address(key)
        with locked(self.path + ".lock"):
            records = self._all()
            records[slot] = self._record(slot, key, address, gmdate_iso())
            self._write(records)
        self._open.pop(slot, None)
        return address
