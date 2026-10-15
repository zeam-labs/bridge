import re

import coincurve
from Crypto.Hash import keccak as _keccak

from .php import is_int, php_describe

_HEX = re.compile(r"^0x([0-9a-fA-F]{2})*$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_XDIGITS = re.compile(r"^[0-9a-fA-F]+$")
_DEC = re.compile(r"^-?[0-9]+$")
_HEXNUM = re.compile(r"^0x[0-9a-fA-F]+$")


def as_bytes(value):
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if value is None:
        return b""
    if value is True:
        return b"1"
    if value is False:
        return b""
    return str(value).encode("utf-8")


class Num:
    @staticmethod
    def of(value):
        if isinstance(value, bool):
            return 1 if value else 0
        if is_int(value):
            return value
        if isinstance(value, str):
            v = value.strip()
            if _HEXNUM.match(v):
                return int(v[2:], 16)
            if _DEC.match(v):
                return int(v, 10)
        if isinstance(value, float) and value.is_integer() and abs(value) < 9007199254740992:
            return int(value)
        raise ValueError("not an integer: " + php_describe(value))

    @staticmethod
    def dec(value):
        return str(Num.of(value))

    @staticmethod
    def to_word(value, signed=False, bits=256):
        n = Num.of(value)
        if bits < 8 or bits > 256 or bits % 8 != 0:
            raise ValueError("integer width must be a multiple of 8 from 8 to 256")
        if signed:
            lim = 1 << (bits - 1)
            if n < -lim or n > lim - 1:
                raise ValueError(f"value out of range for int{bits}")
            if n < 0:
                n = (1 << 256) + n
        elif n < 0 or n > (1 << bits) - 1:
            raise ValueError(f"value out of range for uint{bits}")
        return Num.to_bytes(n, 32)

    @staticmethod
    def to_bytes(value, length):
        n = Num.of(value)
        if n < 0:
            raise ValueError("negative value")
        if n.bit_length() > 8 * length:
            raise ValueError(f"value does not fit in {length} bytes")
        return n.to_bytes(length, "big")

    @staticmethod
    def from_bytes(data, signed=False, bits=256):
        n = int.from_bytes(data, "big") if data else 0
        if signed and data and data[0] & 0x80:
            n -= 1 << (8 * len(data))
        return n


class Hex:
    @staticmethod
    def is_hex(value, nbytes=None):
        if not isinstance(value, str) or not _HEX.match(value):
            return False
        return nbytes is None or len(value) == 2 + 2 * nbytes

    @staticmethod
    def to_bin(value):
        if not isinstance(value, str):
            raise ValueError("hex value must be a string")
        body = value[2:] if value[:2].lower() == "0x" else value
        if body == "":
            return b""
        if len(body) % 2 != 0 or not _XDIGITS.match(body):
            raise ValueError("not an even-length hex string: " + value[:80])
        return bytes.fromhex(body)

    @staticmethod
    def from_bin(data):
        return "0x" + bytes(data).hex()

    @staticmethod
    def lower(value):
        return Hex.from_bin(Hex.to_bin(value))

    @staticmethod
    def equals(a, b):
        return Hex.lower(a).lower() == Hex.lower(b).lower()


class Keccak:
    @staticmethod
    def hash(data):
        h = _keccak.new(digest_bits=256)
        h.update(as_bytes(data))
        return h.digest()

    @staticmethod
    def hex(data):
        return Hex.from_bin(Keccak.hash(data))

    @staticmethod
    def hash_hex(value):
        return Hex.from_bin(Keccak.hash(Hex.to_bin(value)))

    @staticmethod
    def utf8(text):
        return Keccak.hex(as_bytes(text))

    @staticmethod
    def selector(signature):
        return Keccak.hex(as_bytes(signature))[:10]


class Address:
    ZERO = "0x0000000000000000000000000000000000000000"

    @staticmethod
    def is_address(value):
        return isinstance(value, str) and _ADDRESS.match(value) is not None

    @staticmethod
    def checksum(address):
        if not Address.is_address(address):
            raise ValueError("not an address: " + php_describe(address))
        lower = address[2:].lower()
        digest = Keccak.hash(lower.encode()).hex()
        return "0x" + "".join(c.upper() if c.isalpha() and int(digest[i], 16) >= 8 else c for i, c in enumerate(lower))

    @staticmethod
    def is_checksummed(address):
        return Address.is_address(address) and Address.checksum(address) == address

    @staticmethod
    def equals(a, b):
        return Address.is_address(a) and Address.is_address(b) and a.lower() == b.lower()

    @staticmethod
    def from_public_key(uncompressed):
        data = Hex.to_bin(uncompressed)
        if len(data) == 65 and data[0] == 4:
            data = data[1:]
        if len(data) != 64:
            raise ValueError("an uncompressed public key is 64 or 65 bytes")
        return Address.checksum(Hex.from_bin(Keccak.hash(data)[12:]))


class Secp256k1:
    N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
    HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0

    @staticmethod
    def normalize_private_key(key):
        if isinstance(key, str) and key[:2].lower() != "0x":
            key = "0x" + key
        data = Hex.to_bin(key)
        if len(data) != 32:
            raise ValueError("a private key is 32 bytes")
        k = int.from_bytes(data, "big")
        if k <= 0 or k >= Secp256k1.N:
            raise ValueError("private key out of range")
        return data.hex()

    @staticmethod
    def _key(key):
        return coincurve.PrivateKey(bytes.fromhex(Secp256k1.normalize_private_key(key)))

    @staticmethod
    def public_key(key):
        return "0x" + Secp256k1._key(key).public_key.format(compressed=False).hex()

    @staticmethod
    def private_key_to_address(key):
        return Address.from_public_key(Secp256k1.public_key(key))

    @staticmethod
    def sign_hash(key, digest_hex):
        digest = Hex.to_bin(digest_hex)
        if len(digest) != 32:
            raise ValueError("a digest is 32 bytes")
        sig = Secp256k1._key(key).sign_recoverable(digest, hasher=None)
        rp = sig[64]
        if rp > 1:
            raise RuntimeError("signature recovery id is not representable on Ethereum; retry with a different message")
        return "0x" + sig[:64].hex() + "%02x" % (27 + rp)

    @staticmethod
    def parse_signature(signature):
        data = Hex.to_bin(signature)
        if len(data) == 64:
            r, vs = data[:32], data[32:]
            y = 1 if vs[0] & 0x80 else 0
            s = bytes([vs[0] & 0x7F]) + vs[1:]
            return {"r": r.hex(), "s": s.hex(), "yParity": y}
        if len(data) != 65:
            raise ValueError("a signature is 65 bytes")
        v = data[64]
        if v in (0, 1):
            y = v
        elif v in (27, 28):
            y = v - 27
        else:
            raise ValueError(f"invalid signature v: {v}")
        return {"r": data[:32].hex(), "s": data[32:64].hex(), "yParity": y}

    @staticmethod
    def is_low_s(signature):
        return int(Secp256k1.parse_signature(signature)["s"], 16) <= Secp256k1.HALF_N

    @staticmethod
    def is_canonical(signature):
        data = Hex.to_bin(signature)
        return len(data) == 65 and data[64] in (27, 28) and Secp256k1.is_low_s(signature)

    @staticmethod
    def recover_hash(digest_hex, signature):
        digest = Hex.to_bin(digest_hex)
        if len(digest) != 32:
            raise ValueError("a digest is 32 bytes")
        p = Secp256k1.parse_signature(signature)
        for part in ("r", "s"):
            x = int(p[part], 16)
            if x <= 0 or x >= Secp256k1.N:
                raise ValueError(f"signature {part} out of range")
        try:
            point = coincurve.PublicKey.from_signature_and_message(
                bytes.fromhex(p["r"] + p["s"]) + bytes([p["yParity"]]), digest, hasher=None)
        except Exception:
            raise ValueError("signature does not recover to a point")
        return Address.from_public_key(Hex.from_bin(point.format(compressed=False)))

    @staticmethod
    def hash_message(message):
        if isinstance(message, dict) and "raw" in message:
            data = Hex.to_bin(message["raw"])
        else:
            data = as_bytes(message)
        return Keccak.hex(b"\x19Ethereum Signed Message:\n" + str(len(data)).encode() + data)

    @staticmethod
    def personal_sign(key, message):
        return Secp256k1.sign_hash(key, Secp256k1.hash_message(message))

    @staticmethod
    def recover_personal(message, signature):
        if not Secp256k1.is_low_s(signature):
            raise ValueError("signature s is above half the curve order")
        return Secp256k1.recover_hash(Secp256k1.hash_message(message), signature)

    @staticmethod
    def verify_personal(address, message, signature):
        try:
            return Address.equals(Secp256k1.recover_personal(message, signature), address)
        except ValueError:
            return False

    @staticmethod
    def sign_typed_data(key, domain, types, primary_type, message):
        from .typed_data import TypedData
        return Secp256k1.sign_hash(key, TypedData.hash(domain, types, primary_type, message))

    @staticmethod
    def recover_typed_data(domain, types, primary_type, message, signature):
        from .typed_data import TypedData
        return Secp256k1.recover_hash(TypedData.hash(domain, types, primary_type, message), signature)
