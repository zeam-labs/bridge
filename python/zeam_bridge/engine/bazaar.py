import math

from .settlement.jsonx import Json

DRAFT = "https://json-schema.org/draft/2020-12/schema"
EXTENSION_LIMIT = 4096
HEADER_LIMIT = 12288
ANY_RESULT = {"description": "the tool result as JSON"}
_DEPTH = 8


def _is_object(v):
    return isinstance(v, dict)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _count(v):
    if isinstance(v, bool):
        return 0
    if isinstance(v, int) or (isinstance(v, float) and math.isfinite(v) and v.is_integer()):
        return int(v) if v > 0 else 0
    return 0


def example(schema, depth=0):
    if not _is_object(schema) or depth > _DEPTH:
        return None
    if isinstance(schema.get("examples"), list) and schema["examples"]:
        return schema["examples"][0]
    if "default" in schema:
        return schema["default"]
    if "const" in schema:
        return schema["const"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((t for t in kind if t != "null"), "null")
    if kind is None and _is_object(schema.get("properties")):
        kind = "object"
    if kind == "object":
        props = schema["properties"] if _is_object(schema.get("properties")) else {}
        required = schema["required"] if isinstance(schema.get("required"), list) else []
        return {k: example(props.get(k), depth + 1) for k in required if isinstance(k, str)}
    if kind == "array":
        return [example(schema.get("items"), depth + 1) for _ in range(min(_count(schema.get("minItems")), _DEPTH))]
    if kind == "string":
        return "x" * min(_count(schema.get("minLength")), 64)
    if kind == "integer":
        if _is_number(schema.get("minimum")):
            return int(math.ceil(schema["minimum"]))
        if _is_number(schema.get("exclusiveMinimum")):
            return int(math.floor(schema["exclusiveMinimum"])) + 1
        return 0
    if kind == "number":
        if _is_number(schema.get("minimum")):
            return schema["minimum"]
        if _is_number(schema.get("exclusiveMinimum")):
            return schema["exclusiveMinimum"] + 1
        return 0
    if kind == "boolean":
        return False
    return None


def _output(output_schema):
    shape = {"type": "object", **output_schema} if _is_object(output_schema) else ANY_RESULT
    return {"type": "object", "properties": {"type": {"type": "string"}, "example": shape}, "required": ["type"]}


def bazaar(tool, via="http"):
    if not _is_object(tool) or not _is_object(tool.get("inputSchema")):
        return None
    schema = tool["inputSchema"]
    if via == "mcp":
        info = {"type": "mcp", "toolName": str(tool.get("name") if tool.get("name") is not None else ""), "transport": "streamable-http", "inputSchema": schema}
        shape = {
            "type": "object",
            "properties": {"type": {"type": "string", "const": "mcp"}, "toolName": {"type": "string"},
                           "transport": {"type": "string", "enum": ["streamable-http"]}, "inputSchema": {"type": "object"}},
            "required": ["type", "toolName", "inputSchema"],
            "additionalProperties": False,
        }
    else:
        info = {"type": "http", "method": "POST", "bodyType": "json", "body": example(schema)}
        shape = {
            "type": "object",
            "properties": {"type": {"type": "string", "const": "http"}, "method": {"type": "string", "enum": ["POST"]},
                           "bodyType": {"type": "string", "enum": ["json", "form-data", "text"]}, "body": schema},
            "required": ["type", "method", "bodyType", "body"],
            "additionalProperties": False,
        }
    return {
        "bazaar": {
            "info": {"input": info, "output": {"type": "json"}},
            "schema": {"$schema": DRAFT, "type": "object", "properties": {"input": shape, "output": _output(tool.get("outputSchema"))}, "required": ["input"]},
        }
    }


def for_header(doc):
    ext = doc.get("extensions") if isinstance(doc, dict) else None
    if not _is_object(ext) or "bazaar" not in ext:
        return doc
    if len(Json.encode(ext["bazaar"]).encode()) <= EXTENSION_LIMIT and len(Json.base64(doc)) <= HEADER_LIMIT:
        return doc
    rest = {k: v for k, v in ext.items() if k != "bazaar"}
    out = dict(doc)
    out["extensions"] = rest
    if not rest:
        del out["extensions"]
    return out
