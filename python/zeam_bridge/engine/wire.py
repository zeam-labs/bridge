import json
import re

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def stringify(value):
    out = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), out)
