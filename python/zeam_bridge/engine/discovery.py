import re

CACHE_CONTROL = "max-age=300"
_GUIDANCE = "Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged."
_ON_A_LINE = " On a line a call uses the time it runs, whether or not it succeeds."
_MPP_402 = "; the 402 carries an MPP Payment challenge now, in WWW-Authenticate (method evm, intent charge); a refused MPP credential answers 402 with a fresh challenge and a problem"
_AMOUNT = re.compile(r"(0|[1-9][0-9]*)")


def _text(v):
    return isinstance(v, str) and v != ""


def price(tag):
    if not isinstance(tag, dict) or tag.get("free") is True:
        return None
    if tag.get("varies") is True:
        return {"mode": "dynamic", "currency": "USD"}
    if tag.get("per") == "unit":
        return {"mode": "dynamic", "currency": "USD", "min": "0", "max": tag["upTo"]} if _text(tag.get("upTo")) else None
    if tag.get("per") == "ms":
        return {"mode": "dynamic", "currency": "USD", "min": tag["usd"]} if _text(tag.get("usd")) else None
    amount = tag.get("callUSD") if tag.get("per") == "time" else tag.get("usd")
    return {"mode": "fixed", "currency": "USD", "amount": amount} if _text(amount) else None


def payment_info(tag, mpp=None):
    p = price(tag)
    if p is None:
        return None
    charge = (p["mode"] == "fixed" and isinstance(mpp, dict) and isinstance(mpp.get("amount"), str) and _AMOUNT.fullmatch(mpp["amount"]) is not None
              and _text(mpp.get("currency")) and _text(mpp.get("method")) and _text(mpp.get("intent")))
    if not charge:
        return {"price": p, "protocols": [{"x402": {}}]}
    offer = {"amount": mpp["amount"], "currency": mpp["currency"]}
    if _text(mpp.get("description")):
        offer["description"] = mpp["description"]
    offer["intent"] = mpp["intent"]
    offer["method"] = mpp["method"]
    return {"offers": [offer], "price": p, "protocols": [{"mpp": {"method": mpp["method"], "intent": mpp["intent"], "currency": mpp["currency"]}}, {"x402": {}}]}


def discovery(doc, offers=None, homepage=None, origin=None, mount=""):
    paths = {}
    timed = False
    source = doc.get("paths")
    for path, item in (source.items() if isinstance(source, dict) else ()):
        out = {}
        for method, op in (item.items() if isinstance(item, dict) else ()):
            if not isinstance(op, dict):
                out[method] = op
                continue
            tag = op.get("x-price")
            if isinstance(tag, dict) and tag.get("per") in ("time", "ms"):
                timed = True
            name = op.get("operationId")
            info = payment_info(tag, offers.get(name) if isinstance(offers, dict) and isinstance(name, str) else None)
            nxt = dict(op)
            if isinstance(tag, dict):
                nxt["security"] = []
            if info is not None:
                nxt["x-payment-info"] = info
                responses = op.get("responses")
                required = responses.get("402") if isinstance(responses, dict) else None
                if "offers" in info and isinstance(required, dict) and _text(required.get("description")):
                    nxt["responses"] = {**responses, "402": {**required, "description": required["description"] + _MPP_402}}
            out[method] = nxt
        paths[path if origin is None else mount + path] = out
    out = dict(doc)
    out["info"] = {**doc["info"], "x-guidance": f"{doc['info']['description']}. {_GUIDANCE}{_ON_A_LINE if timed else ''}"}
    if _text(homepage):
        out["x-service-info"] = {"docs": {"homepage": homepage}}
    if origin is not None:
        out["servers"] = [{"url": origin}]
    out["paths"] = paths
    return out
