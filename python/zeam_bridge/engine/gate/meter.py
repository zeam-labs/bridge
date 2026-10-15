import time

from ..php import gmdate_month


class Meter:
    FREE_PER_MONTH = 10000
    CREDIT_BLOCK = 2000

    def __init__(self, store, name, options=None):
        options = options or {}
        self.store = store
        self._name = str(name)
        self.free = max(0, int(options["freePerMonth"])) if options.get("freePerMonth") is not None else self.FREE_PER_MONTH
        self.block = max(1000, int(options["creditBlock"])) if options.get("creditBlock") is not None else self.CREDIT_BLOCK
        self._on_empty = "allow" if options.get("onEmpty") == "allow" else "refuse"
        self._now = options.get("now") if callable(options.get("now")) else None

    def name(self):
        return self._name

    def credit_block(self):
        return self.block

    def on_empty(self):
        return self._on_empty

    def _now_ms(self):
        return int(self._now()) if self._now is not None else int(time.time() * 1000)

    def _key(self):
        return "meter-" + self._name

    def _fresh(self, state):
        month = gmdate_month(self._now_ms() // 1000)
        state = dict(state) if isinstance(state, dict) else {"month": month, "used": 0, "credit": 0, "notes": []}
        for k, v in (("month", month), ("used", 0), ("credit", 0), ("notes", [])):
            state.setdefault(k, v)
        if state["month"] != month:
            state["month"] = month
            state["used"] = 0
        return state

    def usage(self):
        s = self._fresh(self.store.get(self._key()))
        return {"month": s["month"], "used": int(s["used"]), "free": self.free, "credit": int(s["credit"]), "notes": len(s["notes"])}

    def wants_credit(self):
        return self._low_on(self._fresh(self.store.get(self._key())))

    def _low_on(self, s):
        return s["used"] >= self.free and s["credit"] < self.block * 0.1

    def charge(self):
        on_empty, free = self._on_empty, self.free

        def change(state):
            s = self._fresh(state)
            if s["used"] < free:
                s["used"] += 1
                out = {"ok": True, "free": True}
            elif s["credit"] > 0:
                s["credit"] -= 1
                s["used"] += 1
                out = {"ok": True, "credit": s["credit"]}
            elif on_empty == "allow":
                s["used"] += 1
                out = {"ok": True, "unpaid": True}
            else:
                out = {
                    "ok": False,
                    "status": 402,
                    "code": "gate_credit_exhausted",
                    "why": "This gate has no checks left this month. It admits again when the seller adds credit.",
                }
            out["buy"] = self._low_on(s)
            return s, out

        return self.store.update(self._key(), change)

    def add_credit(self, note_id, checks):
        note_id, checks = str(note_id), int(checks)

        def change(state):
            s = self._fresh(state)
            if note_id in s["notes"]:
                return state, {"ok": False, "why": "this note is already added"}
            s["notes"] = s["notes"] + [note_id]
            s["credit"] += checks
            return s, {"ok": True, "credit": s["credit"]}

        return self.store.update(self._key(), change)
