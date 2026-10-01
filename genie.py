"""Create and edit Genie spaces ("answer questions from data") from the portal.

A Genie space is a Databricks object (`/api/2.0/genie/spaces`), so what is made
here also appears on the workspace's own Genie page and the portal still stores
nothing. The space's content is one JSON string, `serialized_space`; the shapes
used here are the ones the API reference documents:

    version 2
    config.sample_questions   [{id: 32-hex, question: [text]}]
    data_sources.tables       [{identifier: catalog.schema.table}]
    instructions.text_instructions   [{id, content: [text]}]   <- not shown in the
                                       reference's example, so treated as unconfirmed

Arrays must be sorted (tables by identifier, others by id) and ids must be unique
32-character lowercase hex, or Databricks rejects the space.

Identity
--------
Create goes through `builder.act`: the admin's token first, the app's service
principal only if Databricks says the token lacks the scope (see builder.py).
Reading, editing and deleting use the admin's own token only, with no fallback,
so Databricks itself decides whether they may - the app's identity is never lent
to change a space the admin could not.

Who can use it
--------------
Sharing is CAN_RUN on `/api/2.0/permissions/genie/<space_id>`: may ask questions,
cannot change it. People also need `SELECT` on the tables, which the portal
cannot grant; the UI says so.

Chat in the portal
------------------
The portal chats with serving endpoints, and a Genie space is not one. So the
wizard can also create a one-tool Supervisor Agent around the space (default
on), which is what shows up under "Your assistants". If that step fails the
space is kept and a warning says so.
"""
from __future__ import annotations

import json
import logging
import re
import uuid

import builder
from dbx import DbxError, call

log = logging.getLogger("portal.genie")

SPACES = "/api/2.0/genie/spaces"
PERMS = "/api/2.0/permissions/genie/"

MAX_TABLES = 50
MAX_QUESTIONS = 20

CHAT_PROMPT = (
    "You answer questions about the company's data using your Genie tool. "
    "Always use the tool to look the answer up instead of guessing numbers. "
    "If the question is unclear, ask one short question first. "
    "Say plainly when the data does not contain the answer."
)


def _check_id(space_id: str) -> str:
    # Goes straight into an upstream URL path.
    if not re.match(r"^[\w\-]{1,64}$", space_id or ""):
        raise DbxError("invalid space id", 400)
    return space_id


def clean(payload: dict) -> dict:
    """Validate what the UI sent. Raises DbxError(400)."""
    title = (payload.get("title") or "").strip()
    if not title:
        raise DbxError("A name is required.", 400)
    if len(title) > 120:
        raise DbxError("The name is too long (120 characters at most).", 400)

    wh = (payload.get("warehouse_id") or "").strip()
    if not re.match(r"^[\w\-]{4,64}$", wh):
        raise DbxError("Choose the SQL warehouse that will run the questions.", 400)

    tables, seen = [], set()
    for t in payload.get("tables") or []:
        t = (t or "").strip()
        if not re.match(r"^[\w\-]+\.[\w\-]+\.[\w\-]+$", t):
            raise DbxError("'" + t + "' is not a valid table name (catalog.schema.table).", 400)
        if t not in seen:
            seen.add(t)
            tables.append(t)
    if not tables:
        raise DbxError("Choose at least one table for it to answer questions about.", 400)
    if len(tables) > MAX_TABLES:
        raise DbxError("A Genie space can use at most %d tables here." % MAX_TABLES, 400)

    questions = []
    for q in payload.get("sample_questions") or []:
        q = (q or "").strip()
        if q and q not in questions:
            questions.append(q[:300])
    if len(questions) > MAX_QUESTIONS:
        raise DbxError("Add at most %d example questions." % MAX_QUESTIONS, 400)

    notes = (payload.get("notes") or "").strip()
    if len(notes) > 8000:
        raise DbxError("The notes are too long (8000 characters at most).", 400)

    return {
        "title": title,
        "description": (payload.get("description") or "").strip(),
        "warehouse_id": wh,
        "tables": tables,
        "sample_questions": questions,
        "notes": notes,
        "access": builder.clean_access(payload.get("access") or []),
        "chat": bool(payload.get("chat", True)),
    }


def _hex() -> str:
    return uuid.uuid4().hex  # 32 lowercase hex characters


def serialize(spec: dict, base: dict | None = None) -> str:
    """The `serialized_space` string.

    When editing, `base` is the space as it already exists and everything this
    builder does not model (joins, SQL examples, benchmarks, other instructions)
    is carried over untouched; only tables, example questions and the one note
    are replaced.
    """
    doc = dict(base or {})
    doc.setdefault("version", 2)

    cfg = dict(doc.get("config") or {})
    have_q = {
        (q.get("question") or [""])[0]: q for q in cfg.get("sample_questions") or [] if q.get("question")
    }
    qs = [have_q.get(t) or {"id": _hex(), "question": [t]} for t in spec["sample_questions"]]
    cfg["sample_questions"] = sorted(qs, key=lambda q: q["id"])
    doc["config"] = cfg

    ds = dict(doc.get("data_sources") or {})
    have_t = {t.get("identifier"): t for t in ds.get("tables") or []}
    ds["tables"] = sorted(
        (have_t.get(i) or {"identifier": i} for i in spec["tables"]), key=lambda t: t["identifier"]
    )
    doc["data_sources"] = ds

    ins = dict(doc.get("instructions") or {})
    texts = list(ins.get("text_instructions") or [])
    if spec["notes"]:
        first = dict(texts[0]) if texts else {"id": _hex()}
        first["content"] = [spec["notes"]]
        texts = [first] + texts[1:]
    elif texts:
        texts = texts[1:]  # the note was cleared
    ins["text_instructions"] = sorted(texts, key=lambda t: t.get("id", ""))
    doc["instructions"] = ins
    return json.dumps(doc)


def _unpack(space: dict) -> dict:
    """Space -> the fields the editor shows."""
    try:
        doc = json.loads(space.get("serialized_space") or "{}")
    except ValueError:
        doc = {}
    texts = (doc.get("instructions") or {}).get("text_instructions") or []
    notes = "".join((texts[0].get("content") or [])) if texts else ""
    return {
        "space_id": space.get("space_id") or space.get("id") or "",
        "title": space.get("title") or "",
        "description": space.get("description") or "",
        "warehouse_id": space.get("warehouse_id") or "",
        "tables": [t.get("identifier") for t in (doc.get("data_sources") or {}).get("tables") or [] if t.get("identifier")],
        "sample_questions": [
            (q.get("question") or [""])[0] for q in (doc.get("config") or {}).get("sample_questions") or []
        ],
        "notes": notes,
        "etag": space.get("etag") or "",
    }


# --- operations -------------------------------------------------------------

def list_spaces(user_tok: str) -> list:
    out, token = [], ""
    for _ in range(5):
        params = {"page_size": 100}
        if token:
            params["page_token"] = token
        d = call("GET", SPACES, user_tok, params=params, headers=builder._headers())
        out += [
            {
                "space_id": s.get("space_id") or s.get("id") or "",
                "title": s.get("title") or "",
                "description": s.get("description") or "",
            }
            for s in d.get("spaces") or []
        ]
        token = d.get("next_page_token") or ""
        if not token:
            break
    return out


def get_space(space_id: str, user_tok: str) -> dict:
    _check_id(space_id)
    s = call("GET", SPACES + "/" + space_id, user_tok, params={"include_serialized_space": "true"},
             headers=builder._headers())
    return _unpack(s)


def _share(space_id: str, access: list, user_tok: str) -> list:
    """CAN_RUN for each chosen team/person, one by one. Returns warnings."""
    warnings = []
    for g in access:
        key = "group_name" if g["kind"] == "group" else "user_name"
        try:
            builder.act("PATCH", PERMS + space_id, user_tok,
                        json={"access_control_list": [{key: g["principal"], "permission_level": "CAN_RUN"}]})
        except DbxError as exc:
            warnings.append(
                "Could not let %s use the Genie space (%s). Share it from the space's own Share button."
                % (g["principal"], str(exc)[:90])
            )
    return warnings


def create(spec: dict, who: dict, user_tok: str) -> dict:
    body = {
        "title": spec["title"],
        "description": spec["description"],
        "warehouse_id": spec["warehouse_id"],
        "serialized_space": serialize(spec),
    }
    space, by = builder.act("POST", SPACES, user_tok, json=body)
    sid = space.get("space_id") or space.get("id") or ""
    if not sid:
        raise DbxError("Databricks created the space but returned no id.", 502)
    log.info("genie space %s created by %s as %s", sid, who.get("user_name"), by)

    warnings = _share(sid, spec["access"], user_tok)

    chat = None
    if spec["chat"]:
        try:
            agent_spec = builder.clean_spec({
                "display_name": spec["title"],
                "description": spec["description"] or "Answers questions about your data.",
                "instructions": CHAT_PROMPT,
                "tools": [{"type": "genie_space", "ref": sid, "description": spec["description"] or spec["title"]}],
                "access": spec["access"],
            })
            made = builder.create_agent(agent_spec, who, user_tok)
            chat = {"agent_id": made["agent_id"], "endpoint_name": made["endpoint_name"], "spec": agent_spec}
            warnings += made.get("warnings") or []
        except DbxError as exc:
            warnings.append(
                "The Genie space was created, but the chat version for this portal could not be "
                "(%s). Create an assistant and add this Genie space as an ability instead." % str(exc)[:110]
            )

    return {
        "space_id": sid,
        "acted_as": by,
        "warnings": warnings,
        "chat": bool(chat),
        "access_pending": len(spec["access"]) if chat else 0,
        "_chat": chat,
    }


def update_space(space_id: str, spec: dict, user_tok: str) -> dict:
    """Edit with the admin's own token only; no service-principal fallback."""
    _check_id(space_id)
    cur = call("GET", SPACES + "/" + space_id, user_tok, params={"include_serialized_space": "true"},
               headers=builder._headers())
    try:
        base = json.loads(cur.get("serialized_space") or "{}")
    except ValueError:
        base = {}
    body = {
        "title": spec["title"],
        "description": spec["description"],
        "warehouse_id": spec["warehouse_id"],
        "serialized_space": serialize(spec, base),
    }
    if cur.get("etag"):
        body["etag"] = cur["etag"]
    call("PATCH", SPACES + "/" + space_id, user_tok, json=body, headers=builder._headers())
    return {"space_id": space_id}


def delete_space(space_id: str, user_tok: str) -> dict:
    _check_id(space_id)
    call("DELETE", SPACES + "/" + space_id, user_tok, headers=builder._headers())
    return {"deleted": space_id}
