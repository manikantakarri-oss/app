"""Saved conversations, kept per person in a Delta table.

Turn on by setting PORTAL_CHAT_TABLE to `catalog.schema.table`, or leave it
unset and it sits beside the problem log (`PORTAL_LOG_TABLE`) as `portal_chats`.
With neither set, history is off and chat works exactly as before.

Whose conversation is whose is decided here, not in the browser: every read,
write and delete is filtered on the caller's user name, which comes from their
own token (never from a request field), and every value is bound as a query
parameter. The portal reads and writes as its service principal, so this filter
is the whole privacy boundary. Anyone with SELECT on the table itself can read
all conversations, so grant that sparingly.

One row per message, append-only. A conversation is the rows sharing an id;
its title is its first question. Deleting a conversation deletes its rows.
"""
from __future__ import annotations

import json
import os
import re
import threading

import store
from logsink import TABLE as _LOG_TABLE

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")

RETENTION_DAYS = int(os.environ.get("PORTAL_CHAT_RETENTION_DAYS", "180") or 180)
MAX_TEXT = 100_000
LIST_LIMIT = 50


def _table() -> str:
    explicit = os.environ.get("PORTAL_CHAT_TABLE", "").strip()
    if explicit:
        return explicit
    parts = _LOG_TABLE.split(".")
    return ".".join(parts[:-1] + ["portal_chats"]) if len(parts) == 3 else ""


TABLE = _table()
QUALIFIED = ".".join("`" + p + "`" for p in TABLE.split(".")) if _NAME_RE.match(TABLE) else ""


def enabled() -> bool:
    return bool(QUALIFIED)


def valid_id(cid: str) -> bool:
    return bool(_ID_RE.match(cid or ""))


_ready = False
_lock = threading.Lock()


def ensure_table() -> None:
    """Create the table once per process, and trim conversations past retention."""
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        store.ensure_table(
            QUALIFIED,
            "CREATE TABLE IF NOT EXISTS " + QUALIFIED + " ("
            "conversation_id STRING, user_name STRING, endpoint STRING, idx INT, "
            "role STRING, content STRING, meta STRING, created_at TIMESTAMP)",
            "DELETE FROM " + QUALIFIED + " WHERE created_at < current_timestamp() - INTERVAL "
            + str(RETENTION_DAYS) + " DAYS",
        )
        _ready = True


def _p(name: str, value, typ: str = "STRING") -> dict:
    p = {"name": name, "type": typ}
    if value is not None:
        p["value"] = str(value)
    return p


def save(user: str, cid: str, endpoint: str, start_idx: int, messages: list) -> None:
    """Append messages to a conversation. `messages` are {role, text, meta}."""
    if not (enabled() and user and valid_id(cid) and messages):
        return
    ensure_table()
    params = [_p("u", user), _p("cid", cid), _p("ep", endpoint)]
    tuples = []
    for i, m in enumerate(messages):
        params += [
            _p(f"i{i}", start_idx + i, "INT"),
            _p(f"r{i}", m["role"]),
            _p(f"c{i}", (m.get("text") or "")[:MAX_TEXT]),
            _p(f"m{i}", json.dumps(m.get("meta") or {}, ensure_ascii=False)),
        ]
        tuples.append(f"(:cid, :u, :ep, :i{i}, :r{i}, :c{i}, :m{i}, current_timestamp())")
    store.run("INSERT INTO " + QUALIFIED + " VALUES " + ", ".join(tuples), params)


def list_chats(user: str, endpoint: str = "") -> list:
    """This person's conversations, newest first, optionally for one agent."""
    ensure_table()
    params = [_p("u", user)]
    where = "user_name = :u"
    if endpoint:
        where += " AND endpoint = :ep"
        params.append(_p("ep", endpoint))
    rows = store.run(
        "SELECT conversation_id, first(endpoint), "
        "date_format(max(created_at), \"yyyy-MM-dd'T'HH:mm:ss'Z'\"), count(*), min_by(content, idx) "
        "FROM " + QUALIFIED + " WHERE " + where + " "
        "GROUP BY conversation_id ORDER BY max(created_at) DESC LIMIT " + str(LIST_LIMIT),
        params,
    )
    out = []
    for r in rows:
        title = " ".join((r[4] or "").split())
        out.append(
            {
                "id": r[0],
                "endpoint": r[1],
                "updated": r[2],
                "count": int(r[3] or 0),
                "title": (title[:80] + "…") if len(title) > 80 else (title or "Conversation"),
            }
        )
    return out


def get_chat(user: str, cid: str) -> list:
    """The messages of one of this person's conversations, oldest first."""
    if not valid_id(cid):
        return []
    ensure_table()
    rows = store.run(
        # A retry or a second open tab can write the same position twice; keep the latest.
        "SELECT idx, role, content, meta FROM " + QUALIFIED + " "
        "WHERE user_name = :u AND conversation_id = :cid "
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY idx ORDER BY created_at DESC) = 1 ORDER BY idx",
        [_p("u", user), _p("cid", cid)],
    )
    out = []
    for r in rows:
        try:
            meta = json.loads(r[3]) if r[3] else {}
        except json.JSONDecodeError:
            meta = {}
        out.append({"role": r[1], "text": r[2] or "", **{k: meta[k] for k in ("tools", "citations", "attachments", "files") if k in meta}})
    return out


def delete_chat(user: str, cid: str) -> None:
    if not valid_id(cid):
        return
    ensure_table()
    store.run(
        "DELETE FROM " + QUALIFIED + " WHERE user_name = :u AND conversation_id = :cid",
        [_p("u", user), _p("cid", cid)],
    )
