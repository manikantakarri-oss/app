"""Create and edit Agent Bricks Supervisor Agents from the portal.

The portal still stores nothing. A Supervisor Agent made here is a first-class
Databricks object (`/api/2.1/supervisor-agents`): it appears in the workspace's
own Agents UI, and deleting the portal loses nothing.

Identity, and why there is a fallback
-------------------------------------
The Supervisor Agent API wants the API scope `supervisor-agents`, and an Apps
user token cannot be given it (see sync_agents.py - the scope name is rejected as
invalid). So the admin's own token works locally (CLI identity) but is refused
inside a deployed app. The caller is therefore tried first; **only** if
Databricks answers that the token lacks the required scope do we retry as the
app's service principal. Any other refusal (a genuine permission error, a plan
that does not include the feature) is surfaced, never retried, so the fallback
cannot be used to get around a real denial.

Callers are already verified as workspace admins by the route. When the app
identity creates an agent, the admin who asked is given CAN_MANAGE on it, so
ownership does not silently sit with a service principal. `acted_as` in every
result says which identity did the work.

Tool shapes are only those the Databricks API reference documents. Vector Search
is the exception: its nested field is not documented, so it is marked
`unconfirmed` and any rejection is reported (and the half-built agent removed).
"""
from __future__ import annotations

import logging
import os
import re
import time

import access
from dbx import DbxError, app_token, call, in_apps

log = logging.getLogger("portal.builder")

AGENTS = "/api/2.1/supervisor-agents"

# kind -> (label, spec field in the API body, how a reference becomes the spec,
#          confirmed against the API reference?)
# `ref` is whatever identifies the object: a three-part name for Unity Catalog
# objects, an id for Genie spaces and Knowledge Assistants.
TOOL_TYPES: dict[str, dict] = {
    "uc_function": {
        "label": "Unity Catalog function",
        "spec": lambda ref: {"uc_function": {"name": ref}},
        "pattern": r"^[\w\-]+\.[\w\-]+\.[\w\-]+$",
        "confirmed": True,
    },
    "genie_space": {
        "label": "Genie space",
        "spec": lambda ref: {"genie_space": {"id": ref}},
        "pattern": r"^[\w\-]+$",
        "confirmed": True,
    },
    "knowledge_assistant": {
        "label": "Knowledge Assistant",
        "spec": lambda ref: {"knowledge_assistant": {"knowledge_assistant_id": ref}},
        "pattern": r"^[\w\-]+$",
        "confirmed": True,
    },
    "volume": {
        "label": "Unity Catalog volume",
        "spec": lambda ref: {"volume": {"name": ref}},
        "pattern": r"^[\w\-]+\.[\w\-]+\.[\w\-]+$",
        "confirmed": True,
    },
    "uc_connection": {
        "label": "MCP server (Unity Catalog connection)",
        "spec": lambda ref: {"uc_connection": {"name": ref}},
        "pattern": r"^[\w\-]+$",
        "confirmed": True,
    },
    "app": {
        "label": "Databricks app (MCP server)",
        "spec": lambda ref: {"app": {"name": ref}},
        "pattern": r"^[\w\-]+$",
        "confirmed": True,
    },
    "vector_search_index": {
        "label": "Vector Search index",
        "spec": lambda ref: {"vector_search_index": {"name": ref}},
        "pattern": r"^[\w\-]+\.[\w\-]+\.[\w\-]+$",
        "confirmed": False,
    },
}

# No cap on tools per Supervisor Agent. Databricks documents "up to 50 different
# agents and tools" (Azure Databricks docs, Supervisor Agent, updated 2026-10-02)
# and its create screen stops there, but the API does not enforce it. Tested live
# on 2026-10-06 (Azure): one agent took 123 tools (116 UC functions + 7 Genie
# spaces) added one at a time, listed all 123, and answered a question. More than
# 50 sub-agents specifically was not tested (only 7 Genie spaces existed).
# The tools list pages at 100 (`next_page_token`), so always read it with
# `list_tools`, or edits past 100 tools would miss the rest.


def tool_types() -> list:
    return [
        {"type": k, "label": v["label"], "confirmed": v["confirmed"]}
        for k, v in TOOL_TYPES.items()
    ]


# --- calling Databricks ------------------------------------------------------

def _headers() -> dict:
    h = {"Accept": "application/json"}
    wid = os.environ.get("DATABRICKS_WORKSPACE_ID", "")
    if wid:
        h["X-Databricks-Workspace-Id"] = wid
    return h


def _scope_refused(exc: DbxError) -> bool:
    msg = str(exc).lower()
    return exc.status in (401, 403) and "scope" in msg


def act(method: str, path: str, user_tok: str, **kw) -> tuple[object, str]:
    """Call as the admin; retry as the app only if the token lacks the scope.

    Returns (response, "you" | "the portal's service identity").
    """
    kw.setdefault("headers", _headers())
    try:
        return call(method, path, user_tok, **kw), "you"
    except DbxError as exc:
        if not (in_apps() and _scope_refused(exc)):
            raise
        log.info("%s %s: user token lacks scope; retrying as the app identity", method, path)
    return call(method, path, app_token(), **kw), "the portal's service identity"


def list_tools(agent_id: str, user_tok: str) -> tuple[list, str]:
    """Every tool on an agent. Databricks returns 100 per page."""
    tools, token, by = [], "", "you"
    for _ in range(50):  # 5000 tools; a guard against a token that never ends
        data, by = act("GET", AGENTS + "/" + agent_id + "/tools", user_tok,
                       params={"page_token": token} if token else None)
        tools += data.get("tools") or []
        token = data.get("next_page_token") or ""
        if not token:
            break
    return tools, by


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()


# --- validation --------------------------------------------------------------

def clean_spec(payload: dict) -> dict:
    """Validate and normalise what the UI sent. Raises DbxError(400)."""
    name = (payload.get("display_name") or "").strip()
    if not name:
        raise DbxError("A name is required.", 400)
    if len(name) > 120:
        raise DbxError("The name is too long (120 characters at most).", 400)

    tools, seen = [], set()
    for t in payload.get("tools") or []:
        kind = (t.get("type") or "").strip()
        ref = (t.get("ref") or "").strip()
        if kind not in TOOL_TYPES:
            raise DbxError("Unsupported tool type: " + (kind or "(none)"), 400)
        if not re.match(TOOL_TYPES[kind]["pattern"], ref):
            raise DbxError(
                "'" + ref + "' is not a valid " + TOOL_TYPES[kind]["label"] + " reference.", 400
            )
        if (kind, ref) in seen:
            continue
        seen.add((kind, ref))
        tool = {"type": kind, "ref": ref, "description": (t.get("description") or "").strip()}
        # Picked from the MCP catalog (folder name). mcps.plan decides whether it
        # needs deploying first; the app name is then taken from the catalog.
        mcp = (t.get("mcp") or "").strip()
        if mcp:
            if kind != "app" or not re.match(r"^[a-z0-9][a-z0-9-]{0,60}$", mcp):
                raise DbxError("Not a valid catalog tool: " + mcp[:40], 400)
            tool["mcp"] = mcp
        tools.append(tool)

    return {
        "display_name": name,
        "description": (payload.get("description") or "").strip(),
        "instructions": (payload.get("instructions") or "").strip(),
        "tools": tools,
        "files": clean_files(payload.get("files") or {}),
        "access": clean_access(payload.get("access") or []),
    }


MAX_ACCESS = 100


def clean_access(rows: list) -> list:
    """Who to let use the new assistant: [{kind: group|user, principal}].

    Same two kinds the Manage access screen grants to, and the same level
    (CAN_QUERY - may chat with it). Existence is not checked here: Databricks
    refuses an unknown principal when the grant is made.
    """
    out, seen = [], set()
    for r in rows:
        kind = (r.get("kind") or "").strip()
        who = (r.get("principal") or "").strip()
        if kind not in ("group", "user") or not who:
            raise DbxError("Each person or team to give access needs a kind and a name.", 400)
        if len(who) > 200 or any(c in who for c in "\r\n\t"):
            raise DbxError("That name is not valid: " + who[:40], 400)
        if (kind, who) in seen:
            continue
        seen.add((kind, who))
        out.append({"kind": kind, "principal": who})
    if len(out) > MAX_ACCESS:
        raise DbxError("Give access to at most %d people or teams at once." % MAX_ACCESS, 400)
    return out


VOLUME_RE = r"^[\w\-]+\.[\w\-]+\.[\w\-]+$"


def clean_files(f: dict) -> dict:
    """Where the portal puts uploads and looks for results. Blank = not set.

    Stored as endpoint tags (upload_volume / output_volume / accepts), the same
    ones the Manage access screen edits, so the two always agree.
    """
    out = {}
    for key, label in (("upload_volume", "upload"), ("output_volume", "output")):
        v = (f.get(key) or "").strip()
        if v and not re.match(VOLUME_RE, v):
            raise DbxError(
                "The %s folder must look like catalog.schema.volume, got '%s'." % (label, v), 400
            )
        out[key] = v
    raw = f.get("accepts") or ""
    if isinstance(raw, str):
        raw = raw.split(",")
    exts = [str(e).strip().lstrip(".").lower() for e in raw if str(e).strip()]
    if any(not re.match(r"^[a-z0-9]{1,10}$", e) for e in exts):
        raise DbxError("File types must be plain extensions such as xlsx, csv.", 400)
    out["accepts"] = ", ".join(dict.fromkeys(exts))
    return out


def file_tags(spec: dict) -> dict:
    """Tags to write for the file settings. An empty value deletes the tag."""
    f = dict(spec.get("files") or {})
    # An agent with a volume tool reads files; fall back to that volume for
    # uploads when none was chosen (the rule sync_agents.py uses).
    if not f.get("upload_volume"):
        f["upload_volume"] = next((t["ref"] for t in spec["tools"] if t["type"] == "volume"), "")
    return {k: f.get(k, "") for k in ("upload_volume", "output_volume", "accepts")}


def _tool_id(kind: str, ref: str, used: set) -> str:
    """4-63 chars of [\\w.-], unique within the agent."""
    base = (kind.replace("_", "-") + "-" + _slug(ref))[:56].strip("-") or "tool"
    cand, n = base, 2
    while cand in used or len(cand) < 4:
        cand = (base + "-" + str(n))[:63]
        n += 1
    used.add(cand)
    return cand


def _tool_body(t: dict) -> dict:
    body = {"tool_type": t["type"], **TOOL_TYPES[t["type"]]["spec"](t["ref"])}
    # A tool description is how the supervisor decides when to call it, so an
    # empty one is better omitted than sent blank.
    if t.get("description"):
        body["description"] = t["description"]
    return body


def _ref_of(tool: dict) -> str:
    """The reference inside an existing tool, whichever nested field holds it."""
    kind = tool.get("tool_type") or ""
    nested = tool.get(kind) or {}
    return nested.get("knowledge_assistant_id") or nested.get("id") or nested.get("name") or ""


# --- agents ------------------------------------------------------------------

def _check_id(agent_id: str) -> str:
    # Goes straight into an upstream URL path, so nothing but an id may pass.
    if not re.match(r"^[\w\-]{1,64}$", agent_id or ""):
        raise DbxError("invalid agent id", 400)
    return agent_id


def _agent_id(a: dict) -> str:
    return str(a.get("supervisor_agent_id") or a.get("id") or "")


def list_agents(user_tok: str) -> dict:
    data, by = act("GET", AGENTS, user_tok)
    rows = [
        {
            "agent_id": _agent_id(a),
            "display_name": a.get("display_name") or "",
            "description": a.get("description") or "",
            "endpoint_name": a.get("endpoint_name") or "",
            "creator": a.get("creator") or "",
        }
        for a in (data.get("supervisor_agents") or [])
    ]
    return {"agents": rows, "acted_as": by}


def get_agent(agent_id: str, user_tok: str) -> dict:
    _check_id(agent_id)
    agent, by = act("GET", AGENTS + "/" + agent_id, user_tok)
    tools_data, _ = list_tools(agent_id, user_tok)
    tools = []
    for t in tools_data:
        kind = t.get("tool_type") or ""
        if kind not in TOOL_TYPES:
            # A tool made in Databricks that this builder cannot edit. Keep it
            # visible and untouched rather than dropping it on save.
            tools.append({"type": kind, "ref": _ref_of(t), "description": t.get("description") or "",
                          "tool_id": t.get("tool_id") or "", "readonly": True})
            continue
        tools.append({
            "type": kind,
            "ref": _ref_of(t),
            "description": t.get("description") or "",
            "tool_id": t.get("tool_id") or (t.get("name") or "").rsplit("/", 1)[-1],
        })
    return {
        "agent_id": _agent_id(agent),
        "display_name": agent.get("display_name") or "",
        "description": agent.get("description") or "",
        "instructions": agent.get("instructions") or "",
        "endpoint_name": agent.get("endpoint_name") or "",
        "tools": tools,
        "files": _read_files(agent.get("endpoint_name") or ""),
        "acted_as": by,
    }


def _read_files(endpoint_name: str) -> dict:
    """Current file settings, from the endpoint's tags. Blank if unreadable."""
    blank = {"upload_volume": "", "output_volume": "", "accepts": ""}
    if not endpoint_name:
        return blank
    try:
        tags = access._tags(call("GET", "/api/2.0/serving-endpoints/" + endpoint_name,
                                 app_token(), quiet=True))
    except DbxError:
        return blank
    return {k: tags.get(k, "") for k in blank}


def _require_manage(agent_id: str, who: dict) -> None:
    """The caller must hold CAN_MANAGE on this agent in their own right.

    Same rule as access/tag edits: the app identity may be able to edit an agent
    its admins cannot, and must not lend them that.
    """
    try:
        entries = call("GET", access.AGENT_PERMS + agent_id, app_token()).get("access_control_list", [])
    except DbxError as exc:
        raise DbxError("Could not check your permission on this agent: " + str(exc)[:120], exc.status)
    if not access._can_manage(entries, who):
        raise DbxError(
            "You need Manage permission on this agent in Databricks to edit it. "
            "Ask its owner to grant you CAN_MANAGE.", 403,
        )


def _add_tools(agent_id: str, tools: list, used: set, user_tok: str) -> None:
    for t in tools:
        tid = _tool_id(t["type"], t["ref"], used)
        act("POST", AGENTS + "/" + agent_id + "/tools", user_tok,
            params={"tool_id": tid}, json=_tool_body(t))


def create_agent(spec: dict, who: dict, user_tok: str) -> dict:
    """Create the agent and its tools. All-or-nothing: a failed tool removes the agent."""
    body = {"display_name": spec["display_name"], "description": spec["description"]}
    if spec["instructions"]:
        body["instructions"] = spec["instructions"]
    try:
        agent, by = act("POST", AGENTS, user_tok, json=body)
    except DbxError as exc:
        # Seen live (2026-10-09): the raw "ALREADY_EXISTS: Agent with name ... already exists" JSON
        # reached the screen. Names are unique per workspace, including ones this admin cannot see.
        if exc.status == 409 or "ALREADY_EXISTS" in str(exc):
            raise DbxError("An assistant called “%s” already exists in this workspace. Give this one another "
                           "name, or change that one instead." % spec["display_name"], 409)
        raise
    aid = _agent_id(agent)
    if not aid:
        raise DbxError("Databricks created the agent but returned no id.", 502)

    try:
        _add_tools(aid, spec["tools"], set(), user_tok)
    except DbxError as exc:
        # Do not leave a half-built agent that already owns the unique name.
        try:
            act("DELETE", AGENTS + "/" + aid, user_tok)
        except DbxError:
            log.warning("could not remove half-built agent %s after a tool failed", aid)
        raise DbxError("Could not attach a tool, so nothing was created: " + str(exc)[:240], exc.status)

    warnings = []
    try:
        _share_with_creator_and_portal(aid, who, app_token())
    except DbxError as exc:
        warnings.append(
            "The agent was created, but you could not be made its manager automatically (%s). "
            "Ask a workspace admin to grant you CAN_MANAGE on it." % str(exc)[:100]
        )
    log.info("supervisor agent %s created by %s as %s with %d tools",
             aid, who.get("user_name"), by, len(spec["tools"]))
    return {
        "agent_id": aid,
        "endpoint_name": agent.get("endpoint_name") or "",
        "display_name": spec["display_name"],
        "acted_as": by,
        "warnings": warnings,
        "access_pending": len(spec["access"]),
    }


def update_agent(agent_id: str, spec: dict, who: dict, user_tok: str) -> dict:
    """Update the text fields, then reconcile tools (add / remove / re-describe)."""
    _check_id(agent_id)
    _require_manage(agent_id, who)
    body = {
        "display_name": spec["display_name"],
        "description": spec["description"],
        "instructions": spec["instructions"],
    }
    act("PATCH", AGENTS + "/" + agent_id, user_tok,
        params={"update_mask": "display_name,description,instructions"}, json=body)

    existing, by = list_tools(agent_id, user_tok)
    have = {}
    used = set()
    for t in existing:
        tid = t.get("tool_id") or (t.get("name") or "").rsplit("/", 1)[-1]
        used.add(tid)
        have[(t.get("tool_type"), _ref_of(t))] = {"tool_id": tid, "description": t.get("description") or ""}

    want = {(t["type"], t["ref"]): t for t in spec["tools"]}
    # Only tools this builder understands are ever removed - a tool added in
    # Databricks with a type we do not model is left alone.
    for key, cur in have.items():
        if key[0] in TOOL_TYPES and key not in want:
            act("DELETE", AGENTS + "/" + agent_id + "/tools/" + cur["tool_id"], user_tok)
    added = [t for k, t in want.items() if k not in have]
    _add_tools(agent_id, added, used, user_tok)
    for key, t in want.items():
        cur = have.get(key)
        if cur and cur["description"] != t["description"]:
            act("PATCH", AGENTS + "/" + agent_id + "/tools/" + cur["tool_id"], user_tok,
                params={"update_mask": "description"}, json={"description": t["description"]})
    warnings = []
    ep = (act("GET", AGENTS + "/" + agent_id, user_tok)[0] or {}).get("endpoint_name") or ""
    if ep:
        try:
            access.set_meta(ep, file_tags(spec), app_token())
        except DbxError as exc:
            warnings.append(
                "The agent was saved, but its file settings could not be applied (%s). "
                "Set them on the Access page instead." % str(exc)[:100]
            )
    log.info("supervisor agent %s updated by %s", agent_id, who.get("user_name"))
    return {"agent_id": agent_id, "acted_as": by, "warnings": warnings}


def delete_agent(agent_id: str, who: dict, user_tok: str) -> dict:
    _check_id(agent_id)
    _require_manage(agent_id, who)
    _, by = act("DELETE", AGENTS + "/" + agent_id, user_tok)
    log.info("supervisor agent %s deleted by %s", agent_id, who.get("user_name"))
    return {"deleted": agent_id, "acted_as": by}


# --- ownership and portal wiring --------------------------------------------

def _portal_sp(tok: str) -> str:
    if not in_apps():
        return ""
    try:
        app = call("GET", "/api/2.0/apps/" + os.environ.get("DATABRICKS_APP_NAME", "agent-portal"), tok)
    except DbxError:
        return ""
    return app.get("service_principal_client_id") or ""


def _share_with_creator_and_portal(agent_id: str, who: dict, tok: str) -> None:
    """Idempotent: the admin who asked and the portal both get CAN_MANAGE.

    Whichever identity created the agent owns it; the other still needs access
    for the admin to edit it and for the portal to list and manage it.
    """
    acl = []
    if who.get("user_name"):
        acl.append({"user_name": who["user_name"], "permission_level": "CAN_MANAGE"})
    sp = _portal_sp(tok)
    if sp:
        acl.append({"service_principal_name": sp, "permission_level": "CAN_MANAGE"})
    if acl:
        call("PATCH", access.AGENT_PERMS + agent_id, tok, json={"access_control_list": acl})


def finish_provisioning(agent_id: str, endpoint_name: str, spec: dict, who: dict) -> None:
    """Background: once the serving endpoint exists, make it presentable and shared.

    The endpoint is created asynchronously, so it is not there at the moment the
    agent is. Tags carry the name and description (the portal cannot read Agent
    Bricks names - see sync_agents.py), and the endpoint ACL is what decides who
    may chat, so the creator and portal are put on it.
    """
    if not endpoint_name:
        return
    tok = app_token()
    ep = None
    for _ in range(40):  # ~4 minutes
        try:
            ep = call("GET", "/api/2.0/serving-endpoints/" + endpoint_name, tok, quiet=True)
            break
        except DbxError:
            time.sleep(6)
    if not ep:
        log.warning("endpoint %s did not appear, so no tags or access were applied; run sync_agents.py --apply and grant access on the Access page", endpoint_name)
        return
    try:
        tags = {
            "display_name": spec["display_name"],
            "blurb": spec["description"],
            "agent_id": agent_id,
        }
        for k, v in file_tags(spec).items():
            if v:
                tags[k] = v
        access.set_meta(endpoint_name, tags, tok)
        acl = []
        if who.get("user_name"):
            acl.append({"user_name": who["user_name"], "permission_level": "CAN_MANAGE"})
        sp = _portal_sp(tok)
        if sp:
            acl.append({"service_principal_name": sp, "permission_level": "CAN_MANAGE"})
        if acl and ep.get("id"):
            call("PATCH", access.ENDPOINT_PERMS + ep["id"], tok, json={"access_control_list": acl})
    except DbxError as exc:
        log.warning("could not finish wiring %s: %s", endpoint_name, str(exc)[:200])

    # Access chosen in the wizard. Done last and one by one: a bad name must not
    # stop the others, and anything missed can be fixed on People & access.
    target = {"id": ep.get("id"), "agent_id": agent_id}
    given, failed = 0, []
    for g in spec.get("access") or []:
        try:
            access.set_grant(target, g["kind"], g["principal"], "CAN_QUERY", tok)
            given += 1
        except DbxError as exc:
            failed.append(g["principal"])
            log.warning("could not give %s access to %s: %s", g["principal"], endpoint_name, str(exc)[:160])
    if spec.get("access"):
        log.info("access for %s: %d granted, %d failed %s", endpoint_name, given, len(failed), failed)


# --- finding things to attach ------------------------------------------------

def _volumes_via_sql(catalog: str, schema: str, user_tok: str) -> list | None:
    """The folders (volumes) in a schema, as the person, through SQL (`SHOW VOLUMES`).

    Seen live (2026-10-09): a deployed portal's user token cannot list volumes. Databricks
    Apps has no user scope for it (`catalog.volumes` and `unity-catalog.volumes` are both
    refused as invalid scopes), the file store cannot list the volumes of a schema
    ("Path is missing a volume name"), and the fallback identity (the portal's) has no
    USE CATALOG, so nobody could pick a folder to attach a file to. The token does carry
    the SQL scopes, and SHOW VOLUMES answers with exactly what this person may see.
    None when no warehouse could run it."""
    if not (re.match(r"^[\w-]+$", catalog or "") and re.match(r"^[\w-]+$", schema or "")):
        return None
    try:
        whs = (call("GET", "/api/2.0/sql/warehouses", user_tok, quiet=True) or {}).get("warehouses") or []
        whs.sort(key=lambda w: (w.get("state") != "RUNNING", w.get("name") or ""))
        if not whs:
            return None
        r = call("POST", "/api/2.0/sql/statements", user_tok, quiet=True, json={
            "warehouse_id": whs[0]["id"], "statement": "SHOW VOLUMES IN `%s`.`%s`" % (catalog, schema),
            "wait_timeout": "30s", "on_wait_timeout": "CANCEL"})
    except DbxError:
        return None
    if (r.get("status") or {}).get("state") != "SUCCEEDED":
        return None
    cols = [c.get("name") for c in ((r.get("manifest") or {}).get("schema") or {}).get("columns") or []]
    at = cols.index("volume_name") if "volume_name" in cols else len(cols) - 1
    rows = (r.get("result") or {}).get("data_array") or []
    names = sorted({row[at] for row in rows if row and len(row) > at and row[at]})
    return [_row("%s.%s.%s" % (catalog, schema, n), n) for n in names]


def _row(value: str, label: str = "", detail: str = "") -> dict:
    return {"value": value, "label": label or value, "detail": (detail or "")[:160]}


def listing_note(exc: DbxError, kind: str, catalog: str = "", schema: str = "") -> str:
    """Why a picker list is empty, in words. Databricks' own reply is JSON; seen live
    (2026-10-08): listing the folders of a schema the admin may not use answers 403
    "User does not have USE CATALOG ...", which was shown to people raw and cut short."""
    text = str(exc)
    m = re.search(r'"message"\s*:\s*"([^"]+)"', text)
    reason = (m.group(1) if m else text).strip()
    inside = kind in ("volume", "table", "uc_function")
    where = ".".join(x for x in (catalog, schema if inside else "") if x)
    if exc.status in (401, 403) or "PERMISSION_DENIED" in text:
        if inside and catalog and schema:
            return ("You do not have access to look inside %s. Databricks needs USE CATALOG on %s and USE SCHEMA on %s. "
                    "Choose another schema, or type the name if you know it." % (where, catalog, where))
        if kind == "schemas" and catalog:
            return "You do not have access to the catalog %s (Databricks needs USE CATALOG on it). Choose another catalog." % catalog
        return "You do not have permission to list these (%s). You can still type the name if you know it." % reason[:120]
    if exc.status == 404:
        return "%s was not found. It may have been renamed or deleted." % (where or "That")
    return "Could not list these automatically (%s). You can still type the name if you know it." % reason[:140]


def sources(kind: str, user_tok: str, catalog: str = "", schema: str = "") -> dict:
    """Options for the picker. Never raises on a listing failure: the UI also
    accepts a typed reference, so a workspace where discovery is blocked still
    works."""
    items: list = []
    note = ""
    by = "you"
    uc = "/api/2.1/unity-catalog/"
    try:
        if kind == "catalogs":
            d, by = act("GET", uc + "catalogs", user_tok)
            items = [_row(c["name"], detail=c.get("comment")) for c in d.get("catalogs") or []]
        elif kind == "schemas":
            d, by = act("GET", uc + "schemas", user_tok, params={"catalog_name": catalog})
            items = [_row(s["name"], detail=s.get("comment")) for s in d.get("schemas") or []]
        elif kind == "uc_function":
            d, by = act("GET", uc + "functions", user_tok,
                        params={"catalog_name": catalog, "schema_name": schema})
            items = [_row(f["full_name"], f.get("name"), f.get("comment")) for f in d.get("functions") or []]
        elif kind == "volume":
            try:
                d = call("GET", uc + "volumes", user_tok, params={"catalog_name": catalog, "schema_name": schema}, quiet=True)
                items = [_row(v["full_name"], v.get("name"), v.get("comment")) for v in d.get("volumes") or []]
            except DbxError as exc:
                if not _scope_refused(exc):
                    raise
                # A deployed portal's token cannot list volumes (no such Apps scope): ask SQL as the person.
                found = _volumes_via_sql(catalog, schema, user_tok)
                if found is None:
                    d, by = act("GET", uc + "volumes", user_tok, params={"catalog_name": catalog, "schema_name": schema})
                    found = [_row(v["full_name"], v.get("name"), v.get("comment")) for v in d.get("volumes") or []]
                items = found
        elif kind == "warehouses":
            d, by = act("GET", "/api/2.0/sql/warehouses", user_tok)
            items = [_row(w["id"], w.get("name"), (w.get("size") or w.get("cluster_size") or "") + " " + (w.get("state") or "").lower())
                     for w in d.get("warehouses") or [] if w.get("id")]
        elif kind == "table":
            d, by = act("GET", uc + "tables", user_tok,
                        params={"catalog_name": catalog, "schema_name": schema})
            items = [_row(t["full_name"], t.get("name"), t.get("comment")) for t in d.get("tables") or []]
        elif kind == "genie_space":
            d, by = act("GET", "/api/2.0/genie/spaces", user_tok, params={"page_size": 100})
            items = [_row(s.get("space_id") or s.get("id"), s.get("title"), s.get("description"))
                     for s in d.get("spaces") or []]
        elif kind == "knowledge_assistant":
            d, by = act("GET", "/api/2.1/knowledge-assistants", user_tok)
            items = [_row(str(k.get("knowledge_assistant_id") or k.get("id")),
                          k.get("display_name"), k.get("description"))
                     for k in d.get("knowledge_assistants") or []]
        elif kind == "uc_connection":
            d, by = act("GET", uc + "connections", user_tok)
            items = [_row(c["name"], c["name"],
                          (c.get("connection_type") or "") + (" - " + c["comment"] if c.get("comment") else ""))
                     for c in d.get("connections") or []]
        elif kind == "app":
            d, by = act("GET", "/api/2.0/apps", user_tok)
            items = [_row(a["name"], a["name"], a.get("description")) for a in d.get("apps") or []]
        elif kind == "vector_search_index":
            d, by = act("GET", "/api/2.0/vector-search/endpoints", user_tok)
            for ep in (d.get("endpoints") or [])[:20]:
                idx, _ = act("GET", "/api/2.0/vector-search/indexes", user_tok,
                             params={"endpoint_name": ep["name"]})
                items += [_row(i["name"], i["name"], "endpoint " + ep["name"])
                          for i in idx.get("vector_indexes") or []]
        else:
            raise DbxError("unknown source type " + repr(kind), 400)
    except DbxError as exc:
        if exc.status == 400 and "unknown source" in str(exc):
            raise
        note = listing_note(exc, kind, catalog, schema)
    items = [i for i in items if i["value"]]
    items.sort(key=lambda i: i["label"].lower())
    return {"items": items, "note": note, "acted_as": by}
