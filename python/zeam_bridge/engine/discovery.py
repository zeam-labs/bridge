import re

CACHE_CONTROL = "max-age=300"
_GUIDANCE = "Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged."
_ON_A_LINE = " On a line a call uses the time it runs, whether or not it succeeds."
FAILED_CALL = "A failed call is not charged." + _ON_A_LINE
_AMOUNT = re.compile(r"(0|[1-9][0-9]*)")


def percent(share):
    return ("%.2f" % (float(share) * 100)).rstrip("0").rstrip(".")


def refund_rule(cover, pay=None):
    pay = cover if pay is None else pay
    return ("Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a " + str(cover)
            + "% margin; otherwise the buyer pays the refund's gas, with a " + str(pay) + "% margin, in USDC, quoted before the buyer signs that payment.")


def _text(v):
    return isinstance(v, str) and v != ""


def _mpp_402(offers):
    said = "an MPP Payment challenge" if len(offers) == 1 else "MPP Payment challenges"
    pairs = "; ".join(f"method {o['method']}, intent {o['intent']}" for o in offers)
    status = "402 " if all(o["intent"] == "charge" for o in offers) else ""
    return f"; the 402 carries {said} now, in WWW-Authenticate ({pairs}); a refused MPP credential answers {status}with a fresh challenge and a problem"


def _offered(mpp):
    return (isinstance(mpp, dict) and isinstance(mpp.get("amount"), str) and _AMOUNT.fullmatch(mpp["amount"]) is not None
            and _text(mpp.get("currency")) and _text(mpp.get("method")) and _text(mpp.get("intent")))


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
    given = [m for m in (mpp if isinstance(mpp, list) else [mpp]) if _offered(m)] if p["mode"] == "fixed" else []
    if not given:
        return {"price": p, "protocols": [{"x402": {}}]}
    offers = []
    for m in given:
        offer = {"amount": m["amount"], "currency": m["currency"]}
        if _text(m.get("description")):
            offer["description"] = m["description"]
        offer["intent"] = m["intent"]
        offer["method"] = m["method"]
        offers.append(offer)
    protocols = [{"mpp": {"method": m["method"], "intent": m["intent"], "currency": m["currency"]}} for m in given]
    return {"offers": offers, "price": p, "protocols": protocols + [{"x402": {}}]}


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
                    nxt["responses"] = {**responses, "402": {**required, "description": required["description"] + _mpp_402(info["offers"])}}
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
