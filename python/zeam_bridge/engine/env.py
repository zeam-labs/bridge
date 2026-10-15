import os
import sys

NEW = "BRIDGE_"
OLD = "PASS_"
SHARED_WITH_PASS_CLIENT = ("NAME", "STATE_DIR")
_warned = set()


def _say(line):
    print(line, file=sys.stderr)


def setting(name, env=None, say=None):
    if not name.startswith(NEW):
        raise ValueError(f"bridge: a setting is named {NEW}…; got {name}")
    env = os.environ if env is None else env
    if env.get(name):
        return env.get(name)
    key = name[len(NEW):]
    old = env.get(OLD + key)
    if not old:
        return None
    if key in SHARED_WITH_PASS_CLIENT and key not in _warned:
        _warned.add(key)
        (say or _say)(f"bridge: {name} is not set, so {OLD}{key} is used; the Pass client reads {OLD}{key} too. Set {name}.")
    return old
