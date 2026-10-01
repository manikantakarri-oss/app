"""Real model-serving spend, from the workspace's own billing tables.

Used by the admin Costs view (`/api/admin/cost`) and the per-person cost
estimate in `dashboard.py`. Queries run as the signed-in admin, because
system.billing is granted to people rather than to the app.

(The portal used to offer foundation models as a "General assistant" tab,
switched on by a `portal-llm-users` workspace group. That was removed; only
the cost half of this module remains.)
"""
from __future__ import annotations

import httpx

from dbx import DbxError, call, host, http


def _warehouse(user_tok: str) -> str:
    data = call("GET", "/api/2.0/sql/warehouses", user_tok)
    whs = data.get("warehouses", []) or []
    if not whs:
        raise DbxError("no SQL warehouse is available to read billing data", 503)
    for w in whs:
        if w.get("state") == "RUNNING":
            return w["id"]
    return whs[0]["id"]


def _sql(query: str, user_tok: str, warehouse: str) -> list:
    """Run one statement as the signed-in user; they need system.billing access."""
    try:
        resp = http().post(
            host() + "/api/2.0/sql/statements",
            headers={"Authorization": "Bearer " + user_tok},
            json={"statement": query, "warehouse_id": warehouse, "wait_timeout": "50s"},
            timeout=120,
        )
    except httpx.RequestError as exc:
        raise DbxError("could not reach SQL: " + str(exc), 504)
    if resp.status_code >= 400:
        raise DbxError((resp.text or "")[:300], resp.status_code)
    body = resp.json()
    state = (body.get("status") or {}).get("state")
    if state != "SUCCEEDED":
        msg = ((body.get("status") or {}).get("error") or {}).get("message") or state
        raise DbxError("billing query failed: " + str(msg), 502)
    return (body.get("result") or {}).get("data_array") or []


# Grouped by endpoint, not by SKU: `usage_metadata.endpoint_name` says which
# model was actually paid for, which is the question people ask. Supervisor
# agents (mas-*) bill under their own product, SUPERVISOR_AGENT, with the agent's
# endpoint name in usage_metadata - so they are included alongside MODEL_SERVING
# and appear as their own line. Verified against system.billing.usage.
SPEND_SQL = """
SELECT COALESCE(u.usage_metadata.endpoint_name, u.sku_name) AS item,
       SUM(u.usage_quantity)                                AS dbus,
       SUM(u.usage_quantity * p.pricing.default)            AS usd
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
       ON p.sku_name = u.sku_name AND p.price_end_time IS NULL
WHERE u.billing_origin_product IN ('MODEL_SERVING', 'SUPERVISOR_AGENT')
  AND u.usage_date >= date_sub(current_date(), {days})
GROUP BY 1
HAVING SUM(u.usage_quantity) > 0
ORDER BY usd DESC NULLS LAST
LIMIT 25
"""


def _pretty_model(name: str) -> str:
    """`databricks-claude-fable-5` -> `Claude Fable 5`."""
    if not name.startswith("databricks-"):
        return name
    stem = name[len("databricks-") :]
    words = []
    for part in stem.split("-"):
        if part.isdigit():
            words.append(part)
        elif part in ("oss", "bge", "gte"):
            words.append(part.upper())
        else:
            words.append(part.capitalize())
    # "Claude Fable 5 1" reads worse than "Claude Fable 5.1"
    out = " ".join(words)
    return out.replace(" 5 1", " 5.1").replace(" 4 5", " 4.5").replace(" 4 6", " 4.6").replace(
        " 4 7", " 4.7"
    ).replace(" 4 8", " 4.8").replace(" 4 1", " 4.1").replace(" 3 1", " 3.1").replace(
        " 3 3", " 3.3"
    )


def spend(user_tok: str, days: int = 30) -> dict:
    """Real model-serving spend, from the workspace's own billing tables.

    Read as the signed-in admin, because system.billing is granted to people
    rather than to the app. Returns a `note` instead of raising when billing is
    unreadable - a cost panel that cannot load must not break the console.
    """
    days = 7 if days <= 7 else (90 if days >= 90 else 30)
    try:
        wh = _warehouse(user_tok)
        rows = _sql(SPEND_SQL.format(days=days), user_tok, wh)
    except DbxError as exc:
        return {"days": days, "available": False, "note": str(exc), "lines": [], "total_usd": None}

    lines, total = [], 0.0
    for r in rows:
        item = r[0] or ""
        dbus = float(r[1]) if r[1] is not None else 0.0
        usd = float(r[2]) if r[2] is not None else None
        if usd:
            total += usd
        lines.append(
            {
                "sku": _pretty_model(item),
                "raw": item,
                "dbus": round(dbus, 2),
                "usd": round(usd, 2) if usd else None,
            }
        )
    return {
        "days": days,
        "available": True,
        "note": "",
        "lines": lines,
        "total_usd": round(total, 2),
        "currency": "USD",
    }
