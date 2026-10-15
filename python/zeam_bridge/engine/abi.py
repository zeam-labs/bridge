import re

from .core import Address, Hex, Keccak, Num, as_bytes
from .php import php_describe

_ARRAY = re.compile(r"^(.*)\[(\d*)\]$", re.S)
_INT = re.compile(r"^(u?int)(\d+)$")
_BYTES = re.compile(r"^bytes(\d+)$")
_SIGNATURE = re.compile(r"^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\((.*)\)\s*$", re.S)


def _values(value):
    if isinstance(value, dict):
        return list(value.values())
    return list(value)


class Abi:
    _cache = {}

    @staticmethod
    def parse_type(type_):
        type_ = str(type_).strip()
        node = Abi._cache.get(type_)
        if node is None:
            node = Abi._parse_at(type_)
            Abi._cache[type_] = node
        return node

    @staticmethod
    def _parse_at(type_):
        m = _ARRAY.match(type_)
        if m and Abi._balanced(m.group(1)):
            return {"kind": "array", "of": Abi._parse_at(m.group(1)), "length": None if m.group(2) == "" else int(m.group(2))}
        if type_ and type_[0] == "(":
            if type_[-1] != ")":
                raise ValueError(f"malformed tuple type: {type_}")
            inner = type_[1:-1]
            parts = [] if inner == "" else Abi.split_top(inner)
            return {"kind": "tuple", "components": [Abi._parse_at(p) for p in parts]}
        if type_ in ("address", "bool", "string", "bytes"):
            return {"kind": type_}
        if type_ in ("uint", "int"):
            return {"kind": type_, "bits": 256}
        m = _INT.match(type_)
        if m:
            bits = int(m.group(2))
            if bits < 8 or bits > 256 or bits % 8 != 0:
                raise ValueError(f"invalid integer type: {type_}")
            return {"kind": m.group(1), "bits": bits}
        m = _BYTES.match(type_)
        if m:
            size = int(m.group(1))
            if size < 1 or size > 32:
                raise ValueError(f"invalid fixed bytes type: {type_}")
            return {"kind": "fixedbytes", "size": size}
        raise ValueError(f"unsupported ABI type: {type_}")

    @staticmethod
    def _balanced(s):
        depth = 0
        for c in s:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth < 0:
                    return False
        return depth == 0

    @staticmethod
    def split_top(s):
        out, depth, cur = [], 0, ""
        for c in s:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            if c == "," and depth == 0:
                out.append(cur.strip())
                cur = ""
                continue
            cur += c
        out.append(cur.strip())
        return out

    @staticmethod
    def canonical(node):
        kind = node["kind"]
        if kind in ("uint", "int"):
            return kind + str(node["bits"])
        if kind == "fixedbytes":
            return "bytes" + str(node["size"])
        if kind == "array":
            return Abi.canonical(node["of"]) + "[" + ("" if node["length"] is None else str(node["length"])) + "]"
        if kind == "tuple":
            return "(" + ",".join(Abi.canonical(c) for c in node["components"]) + ")"
        return kind

    @staticmethod
    def parse_signature(signature):
        m = _SIGNATURE.match(signature)
        if not m:
            raise ValueError(f"malformed function signature: {signature}")
        params = [] if m.group(2).strip() == "" else Abi.split_top(m.group(2))
        nodes = [Abi.parse_type(p) for p in params]
        canonical = m.group(1) + "(" + ",".join(Abi.canonical(n) for n in nodes) + ")"
        return {"name": m.group(1), "types": params, "nodes": nodes, "canonical": canonical}

    @staticmethod
    def selector(signature):
        return Keccak.selector(Abi.parse_signature(signature)["canonical"])

    @staticmethod
    def encode_call(signature, args=()):
        sig = Abi.parse_signature(signature)
        args = _values(args)
        if len(args) != len(sig["nodes"]):
            raise ValueError(f"{sig['name']} takes {len(sig['nodes'])} arguments, got {len(args)}")
        return Keccak.selector(sig["canonical"]) + Abi._encode_nodes(sig["nodes"], args).hex()

    @staticmethod
    def encode(types, values):
        nodes = [Abi.parse_type(t) for t in types]
        values = _values(values)
        if len(nodes) != len(values):
            raise ValueError("type and value counts differ")
        return Hex.from_bin(Abi._encode_nodes(nodes, values))

    @staticmethod
    def is_dynamic(node):
        kind = node["kind"]
        if kind in ("bytes", "string"):
            return True
        if kind == "array":
            return node["length"] is None or Abi.is_dynamic(node["of"])
        if kind == "tuple":
            return any(Abi.is_dynamic(c) for c in node["components"])
        return False

    @staticmethod
    def _head_size(node):
        if Abi.is_dynamic(node):
            return 32
        if node["kind"] == "array":
            return node["length"] * Abi._head_size(node["of"])
        if node["kind"] == "tuple":
            return sum(Abi._head_size(c) for c in node["components"])
        return 32

    @staticmethod
    def _encode_nodes(nodes, values):
        head_len = sum(Abi._head_size(n) for n in nodes)
        head, tail = b"", b""
        for i, node in enumerate(nodes):
            if i >= len(values):
                raise ValueError(f"missing value at position {i}")
            enc = Abi.encode_value(node, values[i])
            if Abi.is_dynamic(node):
                head += Num.to_word(head_len + len(tail))
                tail += enc
            else:
                head += enc
        return head + tail

    @staticmethod
    def encode_value(node, value):
        kind = node["kind"]
        if kind == "uint":
            return Num.to_word(value, False, node["bits"])
        if kind == "int":
            return Num.to_word(value, True, node["bits"])
        if kind == "bool":
            if not isinstance(value, bool):
                raise ValueError("bool value must be true or false")
            return b"\0" * 31 + (b"\x01" if value else b"\x00")
        if kind == "address":
            if not Address.is_address(value):
                raise ValueError("not an address: " + php_describe(value))
            body = value[2:]
            if body.lower() != body and body.upper() != body and Address.checksum(value) != value:
                raise ValueError(f"address has a bad checksum: {value}")
            return b"\0" * 12 + bytes.fromhex(body)
        if kind == "fixedbytes":
            data = Hex.to_bin(value)
            if len(data) != node["size"]:
                raise ValueError(f"bytes{node['size']} value has {len(data)} bytes")
            return data.ljust(32, b"\0")
        if kind in ("bytes", "string"):
            data = Hex.to_bin(value) if kind == "bytes" else as_bytes(value)
            pad = (32 - len(data) % 32) % 32
            return Num.to_word(len(data)) + data + b"\0" * pad
        if kind == "array":
            if not isinstance(value, (list, tuple, dict)):
                raise ValueError("array value expected for " + Abi.canonical(node))
            items = _values(value)
            if node["length"] is not None and len(items) != node["length"]:
                raise ValueError(f"{Abi.canonical(node)} needs {node['length']} items")
            body = Abi._encode_nodes([node["of"]] * len(items), items)
            return Num.to_word(len(items)) + body if node["length"] is None else body
        if kind == "tuple":
            if not isinstance(value, (list, tuple, dict)):
                raise ValueError("tuple value expected for " + Abi.canonical(node))
            items = _values(value)
            if len(items) != len(node["components"]):
                raise ValueError(f"{Abi.canonical(node)} needs {len(node['components'])} fields")
            return Abi._encode_nodes(node["components"], items)
        raise ValueError("cannot encode " + kind)

    @staticmethod
    def decode(types, data):
        nodes = [Abi.parse_type(t) for t in types]
        return Abi._decode_nodes(nodes, Hex.to_bin(data), 0)

    @staticmethod
    def _word(data, pos):
        if pos < 0 or pos + 32 > len(data):
            raise ValueError("ABI data is too short")
        return data[pos:pos + 32]

    @staticmethod
    def _offset(data, pos):
        n = Num.from_bytes(Abi._word(data, pos))
        if n > len(data):
            raise ValueError("ABI offset out of range")
        return n

    @staticmethod
    def _decode_nodes(nodes, data, start):
        out, cursor = [], start
        for node in nodes:
            if Abi.is_dynamic(node):
                out.append(Abi._decode_value(node, data, start + Abi._offset(data, cursor)))
                cursor += 32
            else:
                out.append(Abi._decode_value(node, data, cursor))
                cursor += Abi._head_size(node)
        return out

    @staticmethod
    def _decode_value(node, data, pos):
        kind = node["kind"]
        if kind == "uint":
            return str(Num.from_bytes(Abi._word(data, pos)))
        if kind == "int":
            return str(Num.from_bytes(Abi._word(data, pos), True))
        if kind == "bool":
            return Abi._word(data, pos)[31] != 0
        if kind == "address":
            return Address.checksum("0x" + Abi._word(data, pos)[12:].hex())
        if kind == "fixedbytes":
            return Hex.from_bin(Abi._word(data, pos)[:node["size"]])
        if kind in ("bytes", "string"):
            n = Abi._offset(data, pos)
            if pos + 32 + n > len(data):
                raise ValueError("ABI data is too short")
            raw = data[pos + 32:pos + 32 + n]
            return Hex.from_bin(raw) if kind == "bytes" else raw.decode("utf-8", "replace")
        if kind == "array":
            if node["length"] is None:
                count = Abi._offset(data, pos)
                return Abi._decode_nodes([node["of"]] * count, data, pos + 32)
            return Abi._decode_nodes([node["of"]] * node["length"], data, pos)
        if kind == "tuple":
            return Abi._decode_nodes(node["components"], data, pos)
        raise ValueError("cannot decode " + kind)
