"""Per-person dashboards, built from the saved chat history.

Everything here is computed from the chat table (`chats.py`) - the one place the
portal records what people did - so the dashboard needs saved history switched
on, and it only covers chats saved since then. With history off it says so and
shows no numbers rather than zeros that look like facts.

Privacy
-------
* A person's own dashboard is filtered on the user name taken from **their own
  token**, never from a request field. Same rule, same reason, as `chats.py`.
* An admin can see anyone's *counts* (questions, conversations, files, last
  active). Nobody's questions, answers or chat titles are exposed: saved chats
  stay private to their owner, which is what the rest of the portal promises.

Cost per person is an estimate
------------------------------
Databricks bills per endpoint, not per person, so the true per-person cost is not
recorded anywhere the portal can read. The estimate splits each endpoint's real
billed cost (from `llm.spend`) across the people who used it, in proportion to
their questions to it in the same period. Cost from anyone not using the portal
(direct calls, or endpoints nobody asked through the portal) is shown separately
as "not from the portal", never silently spread over people. It is labelled as
an estimate everywhere it appears.
"""
from __future__ import annotations

import datetime as dt
import json

import chats
import llm
import store
from dbx import DbxError

PERIODS = (7, 30, 90)
TOP = 10
MAX_USERS = 200


def period(days) -> int:
    try:
        d = int(days)
    except (TypeError, ValueError):
        return 30
    return 7 if d <= 7 else (90 if d >= 90 else 30)


def _p(name: str, value) -> dict:
    return {"name": name, "type": "STRING", "value": str(value)}


def _cte(days: int, user: bool, before: int = 0) -> str:
    """The messages in the window, with duplicate writes removed.

    `before` ends the window that many days ago, so `_cte(30, ..., before=30)` is
    the 30 days before the last 30 - what "compared with the previous period"
    needs. A retry or a second open tab can write the same position twice, so keep
    one row per (person, conversation, position) - the latest.
    """
    where = "created_at >= current_timestamp() - INTERVAL " + str(int(days) + int(before)) + " DAYS"
    if before:
        where += " AND created_at < current_timestamp() - INTERVAL " + str(int(before)) + " DAYS"
    if user:
        where = "user_name = :u AND " + where
    return (
        "WITH m AS (SELECT * FROM " + chats.QUALIFIED + " WHERE " + where + " "
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY user_name, conversation_id, idx "
        "ORDER BY created_at DESC) = 1) "
    )


def _num(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _pretty(endpoint: str, names: dict) -> str:
    return names.get(endpoint) or llm._pretty_model(endpoint) or endpoint


def _per_day(rows: list, days: int) -> list:
    """One entry for every day in the window, zero where nothing happened."""
    have = {r[0]: _num(r[1]) for r in rows}
    today = dt.date.today()
    out = []
    for i in range(days - 1, -1, -1):
        d = (today - dt.timedelta(days=i)).isoformat()
        out.append({"day": d, "questions": have.get(d, 0)})
    return out


def _off(days: int) -> dict:
    return {
        "enabled": False,
        "days": days,
        "note": "Saved chat history is turned off, so there is nothing to summarise yet. "
                "An admin can switch it on (PORTAL_CHAT_TABLE).",
    }


def activity(user: str, days, names: dict | None = None) -> dict:
    """One person's counts. `user` must come from a verified token or an admin's choice."""
    days = period(days)
    if not chats.enabled():
        return _off(days)
    names = names or {}
    chats.ensure_table()
    cte = _cte(days, True)
    p = [_p("u", user)]

    t = store.run(
        cte + "SELECT count_if(role = 'user'), count(DISTINCT conversation_id), count(DISTINCT endpoint), "
        "sum(CASE WHEN role = 'user' THEN coalesce(size(from_json(meta, 'struct<files:array<string>>').files), 0) ELSE 0 END), "
        "sum(CASE WHEN role = 'assistant' THEN coalesce(size(from_json(meta, "
        "'struct<attachments:array<struct<path:string>>>').attachments), 0) ELSE 0 END), "
        "date_format(max(created_at), \"yyyy-MM-dd'T'HH:mm:ss'Z'\") FROM m",
        p,
    )
    row = (t or [[0, 0, 0, 0, 0, None]])[0]
    # The same two headline counts for the period just before, for "up/down since".
    prev = store.run(
        _cte(days, True, before=days) + "SELECT count_if(role = 'user'), count(DISTINCT conversation_id) FROM m", p
    )
    prow = (prev or [[0, 0]])[0]
    by_ep = store.run(
        cte + "SELECT endpoint, count_if(role = 'user'), "
        "date_format(max(created_at), \"yyyy-MM-dd'T'HH:mm:ss'Z'\") FROM m "
        "GROUP BY endpoint HAVING count_if(role = 'user') > 0 ORDER BY 2 DESC LIMIT " + str(TOP),
        p,
    )
    by_day = store.run(
        cte + "SELECT date_format(created_at, 'yyyy-MM-dd'), count_if(role = 'user') FROM m GROUP BY 1",
        p,
    )
    return {
        "enabled": True,
        "days": days,
        "note": "",
        "questions": _num(row[0]),
        "conversations": _num(row[1]),
        "assistants": _num(row[2]),
        "files_sent": _num(row[3]),
        "files_back": _num(row[4]),
        "last_active": row[5] or "",
        "previous": {"questions": _num(prow[0]), "conversations": _num(prow[1])},
        "per_day": _per_day(by_day, days),
        "top_assistants": [
            {"name": r[0], "label": _pretty(r[0], names), "questions": _num(r[1]), "last_used": r[2] or ""}
            for r in by_ep
        ],
    }


def everyone(days, names: dict | None = None) -> dict:
    """Ranked table of people. Counts only; nothing anyone typed."""
    days = period(days)
    if not chats.enabled():
        return {**_off(days), "people": []}
    chats.ensure_table()
    rows = store.run(
        _cte(days, False) + "SELECT user_name, count_if(role = 'user'), count(DISTINCT conversation_id), "
        "count(DISTINCT endpoint), date_format(max(created_at), \"yyyy-MM-dd'T'HH:mm:ss'Z'\") FROM m "
        "GROUP BY user_name HAVING count_if(role = 'user') > 0 ORDER BY 2 DESC LIMIT " + str(MAX_USERS)
    )
    people = [
        {"user": r[0], "questions": _num(r[1]), "conversations": _num(r[2]), "assistants": _num(r[3]), "last_active": r[4] or ""}
        for r in rows
    ]
    return {"enabled": True, "days": days, "note": "", "people": people}


FILES_LIMIT = 40


def insights(user: str, days, names: dict | None = None) -> dict:
    """The rest of one person's own dashboard: when they work, and their files.

    Only ever called with the caller's own name (from their token). Hours come
    back as UTC hour buckets so the browser can place them in the viewer's own
    time zone. Files are read from the message metadata the chat route saved:
    names the person attached, and the files assistants handed back (with their
    volume path, so they can be downloaded again through `/api/download`, which
    still checks the agent's output location and the caller's access).
    """
    days = period(days)
    if not chats.enabled():
        return {**_off(days), "hours": [], "files": []}
    names = names or {}
    chats.ensure_table()
    cte = _cte(days, True)
    p = [_p("u", user)]
    hours = store.run(
        cte + "SELECT date_format(created_at, \"yyyy-MM-dd'T'HH:00:00'Z'\"), count_if(role = 'user') FROM m "
        "GROUP BY 1 HAVING count_if(role = 'user') > 0",
        p,
    )
    # json.dumps writes `"files": ["` / `"attachments": [{` only when the list is
    # non-empty, so these filters skip the many messages that carried no file.
    rows = store.run(
        cte + "SELECT role, endpoint, conversation_id, meta, "
        "date_format(created_at, \"yyyy-MM-dd'T'HH:mm:ss'Z'\") FROM m "
        "WHERE (role = 'assistant' AND meta LIKE '%\"attachments\": [{%') "
        "OR (role = 'user' AND meta LIKE '%\"files\": [\"%') "
        "ORDER BY created_at DESC LIMIT " + str(FILES_LIMIT),
        p,
    )
    files = []
    for role, ep, cid, meta, at in rows:
        try:
            m = json.loads(meta or "{}")
        except (TypeError, ValueError):
            continue
        label = _pretty(ep, names)
        if role == "assistant":
            for a in m.get("attachments") or []:
                path = (a or {}).get("path") or ""
                if path:
                    files.append({"direction": "received", "name": a.get("name") or path.rsplit("/", 1)[-1],
                                  "path": path, "endpoint": ep, "label": label, "at": at or "", "conversation_id": cid})
        else:
            for n in m.get("files") or []:
                if isinstance(n, str) and n:
                    files.append({"direction": "sent", "name": n.rsplit("/", 1)[-1], "path": "",
                                  "endpoint": ep, "label": label, "at": at or "", "conversation_id": cid})
    # Agents often list the person's own upload among their "attachments" (seen
    # live with an Agent Bricks supervisor), which is not a file they got back.
    # Drop received entries that echo a file sent in the same conversation, and
    # repeats of one path - the newest copy is kept, as rows are newest first.
    sent = {(f["conversation_id"], f["name"]) for f in files if f["direction"] == "sent"}
    seen: set = set()
    kept = []
    for f in files:
        if f["direction"] == "received":
            if (f["conversation_id"], f["name"]) in sent or f["path"] in seen:
                continue
            seen.add(f["path"])
        kept.append(f)
    return {
        "enabled": True,
        "days": days,
        "note": "",
        "hours": [{"hour": r[0], "questions": _num(r[1])} for r in hours if r[0]],
        "files": kept[:FILES_LIMIT],
    }


def org(days, names: dict | None = None) -> dict:
    """Adoption across the portal, for admins. Counts only; nothing anyone typed."""
    days = period(days)
    if not chats.enabled():
        return {**_off(days), "per_day": [], "assistants": []}
    names = names or {}
    chats.ensure_table()
    cte = _cte(days, False)
    active = "count(DISTINCT CASE WHEN role = 'user' THEN user_name END)"
    tot = store.run(cte + "SELECT " + active + ", count_if(role = 'user'), count(DISTINCT conversation_id), "
                    "count(DISTINCT endpoint) FROM m")
    row = (tot or [[0, 0, 0, 0]])[0]
    prev = store.run(_cte(days, False, before=days) + "SELECT " + active + ", count_if(role = 'user') FROM m")
    prow = (prev or [[0, 0]])[0]
    # First message ever inside this window. Bounded by chat retention, so "new"
    # means "first seen since history began", which the UI says.
    new = store.run(
        "SELECT count(*) FROM (SELECT user_name, min(created_at) AS f FROM " + chats.QUALIFIED + " "
        "WHERE role = 'user' GROUP BY user_name) WHERE f >= current_timestamp() - INTERVAL " + str(days) + " DAYS"
    )
    by_day = store.run(cte + "SELECT date_format(created_at, 'yyyy-MM-dd'), count_if(role = 'user'), " + active +
                       " FROM m GROUP BY 1")
    by_ep = store.run(
        cte + "SELECT endpoint, count_if(role = 'user'), count(DISTINCT user_name), "
        "date_format(max(created_at), \"yyyy-MM-dd'T'HH:mm:ss'Z'\") FROM m "
        "GROUP BY endpoint HAVING count_if(role = 'user') > 0 ORDER BY 2 DESC LIMIT 50"
    )
    have = {r[0]: (_num(r[1]), _num(r[2])) for r in by_day}
    today = dt.date.today()
    per_day = []
    for i in range(days - 1, -1, -1):
        d = (today - dt.timedelta(days=i)).isoformat()
        q, a = have.get(d, (0, 0))
        per_day.append({"day": d, "questions": q, "people": a})
    return {
        "enabled": True,
        "days": days,
        "note": "",
        "people": _num(row[0]),
        "questions": _num(row[1]),
        "conversations": _num(row[2]),
        "assistants": _num(row[3]),
        "new_people": _num((new or [[0]])[0][0]),
        "previous": {"people": _num(prow[0]), "questions": _num(prow[1])},
        "per_day": per_day,
        "assistants_used": [
            {"name": r[0], "label": _pretty(r[0], names), "questions": _num(r[1]), "people": _num(r[2]), "last_used": r[3] or ""}
            for r in by_ep
        ],
    }


def costs(days, admin_tok: str, names: dict | None = None) -> dict:
    """Estimated cost per person: each endpoint's billed cost, shared by use."""
    days = period(days)
    if not chats.enabled():
        return {**_off(days), "available": False, "rows": [], "unattributed_usd": None, "total_usd": None}
    spend = llm.spend(admin_tok, days)
    if not spend.get("available"):
        return {
            "enabled": True, "available": False, "days": days, "rows": [],
            "note": "Cost figures are not available. " + str(spend.get("note") or ""),
            "unattributed_usd": None, "total_usd": None,
        }
    chats.ensure_table()
    use = store.run(
        _cte(days, False) + "SELECT user_name, endpoint, count_if(role = 'user') FROM m "
        "GROUP BY user_name, endpoint HAVING count_if(role = 'user') > 0"
    )
    per_ep: dict = {}
    for u, ep, q in use:
        per_ep.setdefault(ep, {})[u] = per_ep.setdefault(ep, {}).get(u, 0) + _num(q)

    cost: dict = {}
    questions: dict = {}
    for u, ep, q in use:
        questions[u] = questions.get(u, 0) + _num(q)
    unattributed = 0.0
    for line in spend["lines"]:
        usd = line.get("usd")
        if not usd:
            continue
        users = per_ep.get(line.get("raw"))
        total_q = sum(users.values()) if users else 0
        if not total_q:
            unattributed += usd
            continue
        for u, q in users.items():
            cost[u] = cost.get(u, 0.0) + usd * q / total_q

    rows = sorted(
        ({"user": u, "est_usd": round(c, 2), "questions": questions.get(u, 0)} for u, c in cost.items()),
        key=lambda r: r["est_usd"], reverse=True,
    )[:MAX_USERS]
    return {
        "enabled": True,
        "available": True,
        "days": days,
        "note": "",
        "rows": rows,
        "unattributed_usd": round(unattributed, 2),
        "total_usd": spend.get("total_usd"),
    }
