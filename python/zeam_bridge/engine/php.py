import datetime
import decimal
import math
import re

_NUMERIC = re.compile(r"^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$")
_ISO = re.compile(
    r"^\s*(\d{4})-(\d{2})-(\d{2})"
    r"(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?"
    r"\s*(Z|z|UTC|[+-]\d{2}(?::?\d{2})?)?\s*$"
)


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def is_scalar(value):
    return isinstance(value, (str, int, float))


def php_str(value):
    if value is None or value is False:
        return ""
    if value is True:
        return "1"
    if is_int(value):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NAN"
        if math.isinf(value):
            return "INF" if value > 0 else "-INF"
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return repr(value).replace("e+", "E+").replace("e-", "E-")
    return str(value)


def php_empty(value):
    if value is None or value is False:
        return True
    if is_int(value):
        return value == 0
    if isinstance(value, float):
        return value == 0.0
    if isinstance(value, str):
        return value == "" or value == "0"
    if isinstance(value, (list, dict, tuple)):
        return len(value) == 0
    return False


def is_numeric(value):
    if is_int(value) or isinstance(value, float):
        return True
    return isinstance(value, str) and _NUMERIC.match(value) is not None


def to_float(value):
    if value is None or value is False:
        return 0.0
    if value is True:
        return 1.0
    if is_int(value) or isinstance(value, float):
        return float(value)
    if isinstance(value, str) and is_numeric(value):
        return float(value.strip())
    return 0.0


def to_int(value):
    if value is None or value is False:
        return 0
    if value is True:
        return 1
    if is_int(value):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) else 0
    if isinstance(value, str):
        m = re.match(r"^[ \t\n\r\v\f]*([+-]?\d+)", value)
        if m and not is_numeric(value):
            return int(m.group(1))
        if is_numeric(value):
            f = float(value.strip())
            if re.match(r"^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$", value):
                return int(value.strip())
            return int(f) if math.isfinite(f) else 0
        return 0
    return 0


def php_round(value, digits=0):
    d = decimal.Decimal(repr(float(value)))
    q = decimal.Decimal(1).scaleb(-digits)
    return float(d.quantize(q, rounding=decimal.ROUND_HALF_UP))


def parse_time(text):
    if not isinstance(text, str):
        return None
    m = _ISO.match(text)
    if not m:
        return None
    y, mo, d, h, mi, s, frac, tz = m.groups()
    try:
        base = datetime.datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), int(s or 0), tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    micros = int((frac or "0")[:6].ljust(6, "0"))
    offset = 0
    if tz and tz not in ("Z", "z", "UTC"):
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        offset = sign * (int(digits[:2]) * 3600 + int(digits[2:4] or 0) * 60)
    seconds = int(base.timestamp()) - offset
    return seconds, micros


def strtotime(text):
    t = parse_time(text)
    return None if t is None else t[0]


def time_ms(text):
    t = parse_time(text)
    return None if t is None else int(php_round((t[0] + t[1] / 1e6) * 1000))


def gmdate_month(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime("%Y-%m")


def gmdate_iso(seconds=None):
    when = datetime.datetime.now(datetime.timezone.utc) if seconds is None else datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return when.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def php_type(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "boolean"
    if is_int(value):
        return "integer"
    if isinstance(value, float):
        return "double"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, dict, tuple)):
        return "array"
    return "object"


def php_describe(value):
    return php_str(value) if isinstance(value, (str, int, float, bool)) else php_type(value)
