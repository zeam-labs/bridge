import re

from .abi import Abi, _values
from .core import Hex, Keccak, as_bytes

DOMAIN_FIELDS = (
    ("name", "string"),
    ("version", "string"),
    ("chainId", "uint256"),
    ("verifyingContract", "address"),
    ("salt", "bytes32"),
)


class TypedData:
    DOMAIN_FIELDS = DOMAIN_FIELDS

    @staticmethod
    def domain_types(domain):
        return [{"name": n, "type": t} for n, t in DOMAIN_FIELDS if domain.get(n) is not None]

    @staticmethod
    def hash(domain, types, primary_type, message):
        if "EIP712Domain" not in types:
            types = {**types, "EIP712Domain": TypedData.domain_types(domain)}
        out = b"\x19\x01" + TypedData._hash_struct("EIP712Domain", domain, types)
        if primary_type != "EIP712Domain":
            out += TypedData._hash_struct(primary_type, message, types)
        return Keccak.hex(out)

    @staticmethod
    def encode_type(primary_type, types):
        deps = [d for d in TypedData._dependencies(primary_type, types, []) if d != primary_type]
        deps.sort()
        out = ""
        for t in [primary_type] + deps:
            out += t + "(" + ",".join(f["type"] + " " + f["name"] for f in types[t]) + ")"
        return out

    @staticmethod
    def _base_type(type_):
        m = re.match(r"^([^\[]*)", type_)
        return m.group(1) if m else type_

    @staticmethod
    def _dependencies(primary_type, types, found):
        base = TypedData._base_type(primary_type)
        if base in found or base not in types:
            return found
        found.append(base)
        for field in types[base]:
            found = TypedData._dependencies(field["type"], types, found)
        return found

    @staticmethod
    def _hash_struct(primary_type, data, types):
        if primary_type not in types:
            raise ValueError(f"unknown EIP-712 type: {primary_type}")
        enc = Keccak.hash(TypedData.encode_type(primary_type, types).encode())
        for field in types[primary_type]:
            if not isinstance(data, dict) or field["name"] not in data:
                raise ValueError(f"{primary_type} is missing field {field['name']}")
            enc += TypedData._encode_field(types, field["type"], data[field["name"]])
        return Keccak.hash(enc)

    @staticmethod
    def _encode_field(types, type_, value):
        if type_ in types:
            if not isinstance(value, dict):
                raise ValueError(f"struct value expected for {type_}")
            return TypedData._hash_struct(type_, value, types)
        if type_ == "bytes":
            return Keccak.hash(Hex.to_bin(value))
        if type_ == "string":
            return Keccak.hash(as_bytes(value))
        if type_.endswith("]"):
            if not isinstance(value, (list, tuple, dict)):
                raise ValueError(f"array value expected for {type_}")
            inner = type_[:type_.rindex("[")]
            m = re.search(r"\[(\d+)\]$", type_)
            items = _values(value)
            if m and len(items) != int(m.group(1)):
                raise ValueError(f"{type_} needs {m.group(1)} items")
            return Keccak.hash(b"".join(TypedData._encode_field(types, inner, item) for item in items))
        node = Abi.parse_type(type_)
        if Abi.is_dynamic(node) or node["kind"] in ("tuple", "array"):
            raise ValueError(f"unsupported EIP-712 field type: {type_}")
        return Abi.encode_value(node, value)
