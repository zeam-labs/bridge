from ..php import php_empty
from .channels import n
from .chain import Chain


class Withdrawals:
    def __init__(self, cfg, store, chain=None):
        self.cfg = cfg
        self.store = store
        self.chain = chain or Chain(cfg.rpcUrl)

    def run(self):
        out = {"checked": 0, "withdrawing": [], "cleared": [], "errors": 0}
        now = self.cfg.now_ms()
        for c in self.store.list():
            try:
                if c.get("channelId") is None or n(c.get("balance", "0")) <= 0:
                    continue
            except ValueError:
                continue
            ident = str(c["channelId"]).lower()
            try:
                w = self.chain.pending_withdrawal(ident)
            except Exception:
                out["errors"] += 1
                continue
            out["checked"] += 1
            leaving = n(w["amount"]) > 0
            stamped = not php_empty(c.get("withdrawRequestedAt"))
            if leaving:
                out["withdrawing"].append(ident)
            if leaving == stamped:
                continue

            def stamp(r, leaving=leaving):
                if r is None:
                    return None
                r["withdrawRequestedAt"] = now if leaving else 0
                return r

            self.store.update(ident, stamp)
            if not leaving:
                out["cleared"].append(ident)
        return out
