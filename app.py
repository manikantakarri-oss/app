"""Agent Portal - a friendly front door to Databricks agents.

Two audiences, one workspace:

* an end user signs in and sees only the agents they hold CAN_QUERY on, and
  chats with them;
* a workspace admin grants that access from the UI, using Databricks groups as
  reusable "agent sets".

Nothing is stored here. Every read and write lands on Databricks-native state,
so the portal can be deleted and rebuilt without losing configuration.
"""
from __future__ import annotations

import logging
import os
import time

from fastapi import BackgroundTasks, Body, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import access
import audit
import builder
import chat
import genie
import knowledge
import chats
import dashboard
import files as filestore
import llm
import logbuf
import logsink
from dbx import DbxError, app_token, auth_mode, user_token

HERE = os.path.dirname(os.path.abspath(__file__))
# Built by `npm run build` in ui/ (Next.js static export) and copied here.
# Databricks Apps runs one command, so there is no Node server: the export is
# plain files and FastAPI serves them.
WEB = os.path.join(HERE, "web")

app = FastAPI(title="Agent Portal", docs_url="/api/docs")


# stdout/stderr from a Databricks App land in the app's Logs tab (and
# `databricks apps logs <app>`), so plain logging is all that is needed. Tokens
# and request bodies are never logged.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("portal")
log.addHandler(logbuf.buffer)  # in-memory fallback for the admin panel's Logs view
if logsink.enabled():
    log.addHandler(logsink.handler)  # durable copy of problems, in a Delta table
elif logsink.TABLE:
    log.warning("PORTAL_LOG_TABLE=%r is not catalog.schema.table; logs stay in memory only", logsink.TABLE)


def _caller(request: Request) -> str:
    """Who is asking, from the headers the Apps proxy adds. Not a credential."""
    h = request.headers
    return h.get("x-forwarded-email") or h.get("x-forwarded-preferred-username") or "unknown"


def _ctx(request: Request, status: int) -> dict:
    """Structured fields, so the Delta table can be filtered by user or path."""
    return {"extra": {"actor": _caller(request), "method": request.method, "path": request.url.path, "status": status}}


@app.on_event("startup")
async def _more_threads():
    """Room for many people to wait on an assistant at once.

    Every route here is a plain `def`, which Starlette runs in a pool of 40 worker
    threads, and a chat holds one for as long as the assistant takes (seconds to
    minutes). With the default, the 41st simultaneous chat waits for a free thread,
    and so does everything else, including opening the page. The threads only wait
    on the network, so many more are cheap. Tune with PORTAL_THREADS.
    """
    import anyio.to_thread

    try:
        n = max(40, int(os.environ.get("PORTAL_THREADS", "200")))
    except ValueError:
        n = 200
    anyio.to_thread.current_default_thread_limiter().total_tokens = n


@app.middleware("http")
async def _access_log(request: Request, call_next):
    # The Logs panel polls its own route; logging that would fill the view with itself.
    if not request.url.path.startswith("/api/") or request.url.path in ("/api/health", "/api/admin/logs"):
        return await call_next(request)
    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("%s %s user=%s -> unhandled error", request.method, request.url.path, _caller(request), **_ctx(request, 500))
        raise
    ms = int((time.monotonic() - start) * 1000)
    level = logging.WARNING if response.status_code >= 400 else logging.INFO
    log.log(level, "%s %s user=%s -> %s (%d ms)", request.method, request.url.path, _caller(request), response.status_code, ms,
            **_ctx(request, response.status_code))
    return response


@app.exception_handler(DbxError)
async def _dbx_error(request: Request, exc: DbxError):
    # The reason behind a failed Databricks call, e.g. a user without WRITE
    # VOLUME on an upload. The access log above carries the same path and user.
    log.warning("databricks call failed: %s %s user=%s status=%s: %s",
                request.method, request.url.path, _caller(request), exc.status, str(exc)[:500],
                **_ctx(request, exc.status))
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


def _who(forwarded):
    """Resolve the caller. Fails closed if the OBO token is missing in Apps."""
    tok = user_token(forwarded)
    return access.identity(tok), tok


def _require_admin(forwarded):
    who, tok = _who(forwarded)
    if not who["is_admin"]:
        raise HTTPException(403, "Access administration is limited to workspace admins.")
    return who, tok


@app.get("/api/session")
def session(x_forwarded_access_token: str = Header(None)):
    who, _ = _who(x_forwarded_access_token)
    return {**who, "auth_mode": auth_mode(), "chat_history": chats.enabled()}


@app.get("/api/agents")
def agents(x_forwarded_access_token: str = Header(None)):
    who, tok = _who(x_forwarded_access_token)
    return {"agents": access.visible_agents(who, app_token(), tok)}


def _allowed_agent(who: dict, endpoint: str, user_tok: str = "") -> dict:
    """The agent record, or 403. Needed because the task drives the wire format."""
    for a in access.visible_agents(who, app_token(), user_tok):
        if a["name"] == endpoint:
            return a
    raise HTTPException(403, "You do not have access to that agent.")


@app.post("/api/chat")
def send(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    endpoint = (payload.get("endpoint") or "").strip()
    history = payload.get("history") or []
    uploads = [p for p in (payload.get("files") or []) if isinstance(p, str) and p]
    if not endpoint:
        raise HTTPException(400, "endpoint is required")

    who, tok = _who(x_forwarded_access_token)
    # Confirm the agent is one this user may see before spending a call on it.
    # The invocation below still runs under the user's own token, so this check
    # is a courtesy for clearer errors, not the security boundary.
    agent = _allowed_agent(who, endpoint, tok)
    output_dir = filestore.output_dir_path(agent["output_volume"]) if agent.get("output_volume") else ""
    out = chat.ask(endpoint, agent["task"], history, tok, files=uploads, output_dir=output_dir)

    # Saved after the reply has gone out, and only for a successful exchange, so
    # history never slows a chat and never holds a failed attempt.
    cid = (payload.get("conversation_id") or "").strip()
    if chats.enabled() and chats.valid_id(cid) and history and history[-1].get("role") == "user":
        names = [n for n in (payload.get("file_names") or []) if isinstance(n, str)][:20]
        background.add_task(
            _save_chat, who["user_name"], cid, endpoint, len(history) - 1,
            str(history[-1].get("content") or ""), names, out,
        )
    return out


def _save_chat(user: str, cid: str, endpoint: str, idx: int, question: str, names: list, out: dict):
    try:
        chats.save(user, cid, endpoint, idx, [
            {"role": "user", "text": question, "meta": {"files": names}},
            {"role": "assistant", "text": out.get("reply") or "", "meta": {
                "tools": out.get("tools") or [],
                "citations": out.get("citations") or [],
                "attachments": out.get("attachments") or [],
            }},
        ])
    except Exception as exc:  # a failed save must never surface as a failed chat
        log.warning("could not save conversation %s for %s: %s", cid, user, str(exc)[:300])


@app.get("/api/chats")
def chat_list(endpoint: str = "", x_forwarded_access_token: str = Header(None)):
    """The signed-in person's saved conversations, newest first."""
    who, _ = _who(x_forwarded_access_token)
    if not chats.enabled():
        return {"enabled": False, "chats": []}
    return {"enabled": True, "chats": chats.list_chats(who["user_name"], endpoint.strip())}


@app.get("/api/chats/{cid}")
def chat_open(cid: str, x_forwarded_access_token: str = Header(None)):
    who, _ = _who(x_forwarded_access_token)
    if not chats.enabled():
        raise HTTPException(404, "conversation history is not turned on")
    messages = chats.get_chat(who["user_name"], cid)
    if not messages:
        raise HTTPException(404, "no such conversation")
    return {"messages": messages}


@app.delete("/api/chats/{cid}")
def chat_delete(cid: str, x_forwarded_access_token: str = Header(None)):
    who, _ = _who(x_forwarded_access_token)
    if chats.enabled():
        chats.delete_chat(who["user_name"], cid)
    return {"deleted": cid}


@app.post("/api/upload")
async def upload(
    endpoint: str = Form(...),
    file: UploadFile = File(...),
    x_forwarded_access_token: str = Header(None),
):
    """Put a file where a file-driven agent can read it, as the signed-in user."""
    who, tok = _who(x_forwarded_access_token)
    agent = _allowed_agent(who, endpoint.strip(), tok)
    if not agent.get("upload_volume"):
        raise HTTPException(400, "This agent does not accept file uploads.")

    accepts = agent.get("accepts") or []
    name = file.filename or "upload"
    if accepts and not any(name.lower().endswith("." + a.lstrip(".")) for a in accepts):
        raise HTTPException(
            400, "This agent accepts only: " + ", ".join("." + a.lstrip(".") for a in accepts)
        )

    blob = await file.read()
    return filestore.upload(agent["upload_volume"], name, blob, tok)


@app.get("/api/download")
def download(
    endpoint: str,
    path: str,
    x_forwarded_access_token: str = Header(None),
):
    """Fetch a file an agent generated, as the signed-in user."""
    who, tok = _who(x_forwarded_access_token)
    agent = _allowed_agent(who, endpoint.strip(), tok)
    if not agent.get("output_volume"):
        raise HTTPException(400, "This agent does not produce downloadable files.")
    if not filestore.in_volume(path, agent["output_volume"]):
        raise HTTPException(403, "That file is not in this agent's output location.")

    blob = filestore.download(path, tok)
    name = path.rsplit("/", 1)[-1] or "download"
    return Response(
        content=blob,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="' + name.replace('"', "") + '"'},
    )


@app.get("/api/admin/overview")
def overview(x_forwarded_access_token: str = Header(None)):
    who, user_tok = _require_admin(x_forwarded_access_token)
    tok = app_token()
    return {"agents": access.admin_agents(tok, user_tok, who), **access.principals(tok)}


@app.post("/api/admin/grant")
def grant(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    who, _ = _require_admin(x_forwarded_access_token)
    endpoint_id = (payload.get("endpoint_id") or "").strip()
    kind = (payload.get("kind") or "").strip()
    principal = (payload.get("principal") or "").strip()
    if not (endpoint_id and kind and principal):
        raise HTTPException(400, "endpoint_id, kind and principal are required")
    # level omitted or null means revoke
    level = payload.get("level")
    if level not in (None, "", "CAN_QUERY", "CAN_VIEW", "CAN_MANAGE"):
        raise HTTPException(400, "unsupported permission level")

    tok = app_token()
    # Resolve the whole agent: an Agent Bricks agent is governed by its own
    # permission list, not the serving endpoint's, and only the shaped record
    # knows which.
    target = next((a for a in access.all_agents(tok) if a["id"] == endpoint_id), None)
    if not target:
        target = {"id": endpoint_id}
    # The portal must not lend the app's CAN_MANAGE to its users.
    if not access.may_manage(target, who, tok):
        raise HTTPException(
            403,
            "You need Manage permission on this agent in Databricks to change who can use "
            "it. Ask its owner to grant you CAN_MANAGE.",
        )
    return access.set_grant(target, kind, principal, level or None, tok)


@app.post("/api/admin/group")
def new_group(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _require_admin(x_forwarded_access_token)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    # Also grants the group permission to open the portal, so setting up access
    # never needs a terminal.
    return access.create_group(name, app_token(), os.environ.get("DATABRICKS_APP_NAME", "agent-portal"))


@app.post("/api/admin/group-members")
def group_members(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _require_admin(x_forwarded_access_token)
    group_id = (payload.get("group_id") or "").strip()
    users = payload.get("users") or []
    if not group_id:
        raise HTTPException(400, "group_id is required")
    return access.set_group_members(group_id, [u for u in users if u], app_token())


@app.post("/api/admin/meta")
def meta(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    who, _ = _require_admin(x_forwarded_access_token)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    values = {k: payload[k] for k in access.META_TAGS if k in payload}
    if not values:
        raise HTTPException(400, "nothing to update")
    tok = app_token()
    target = next((a for a in access.all_agents(tok) if a["name"] == name), None)
    if not target:
        raise HTTPException(404, "no such agent")
    if not access.may_manage(target, who, tok):
        raise HTTPException(
            403,
            "You need Manage permission on this agent in Databricks to change how it "
            "appears. Ask its owner to grant you CAN_MANAGE.",
        )
    return access.set_meta(name, values, tok)


@app.get("/api/admin/builder/types")
def builder_types(x_forwarded_access_token: str = Header(None)):
    _require_admin(x_forwarded_access_token)
    return {"types": builder.tool_types()}


@app.get("/api/admin/builder/sources")
def builder_sources(
    kind: str,
    catalog: str = "",
    schema: str = "",
    x_forwarded_access_token: str = Header(None),
):
    _, tok = _require_admin(x_forwarded_access_token)
    return builder.sources(kind, tok, catalog, schema)


@app.get("/api/admin/builder/principals")
def builder_principals(x_forwarded_access_token: str = Header(None)):
    """The teams and people that can be given access: the same lists the Manage
    access screen offers."""
    _require_admin(x_forwarded_access_token)
    return access.principals(app_token())


@app.get("/api/admin/builder/agents")
def builder_list(x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return builder.list_agents(tok)


@app.get("/api/admin/builder/agents/{agent_id}")
def builder_get(agent_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return builder.get_agent(agent_id, tok)


@app.post("/api/admin/builder/agents")
def builder_create(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    who, tok = _require_admin(x_forwarded_access_token)
    spec = builder.clean_spec(payload)
    out = builder.create_agent(spec, who, tok)
    # The serving endpoint appears a few minutes later; tag and share it then.
    background.add_task(builder.finish_provisioning, out["agent_id"], out["endpoint_name"], spec, who)
    return out


@app.put("/api/admin/builder/agents/{agent_id}")
def builder_update(
    agent_id: str,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    who, tok = _require_admin(x_forwarded_access_token)
    return builder.update_agent(agent_id, builder.clean_spec(payload), who, tok)


@app.delete("/api/admin/builder/agents/{agent_id}")
def builder_delete(agent_id: str, x_forwarded_access_token: str = Header(None)):
    who, tok = _require_admin(x_forwarded_access_token)
    return builder.delete_agent(agent_id, who, tok)


@app.get("/api/admin/builder/genie")
def genie_list(x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return {"spaces": genie.list_spaces(tok)}


@app.get("/api/admin/builder/genie/{space_id}")
def genie_get(space_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return genie.get_space(space_id, tok)


@app.post("/api/admin/builder/genie")
def genie_create(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    who, tok = _require_admin(x_forwarded_access_token)
    out = genie.create(genie.clean(payload), who, tok)
    chat_ = out.pop("_chat", None)
    if chat_:
        # Same follow-up as any supervisor: tag and share its endpoint once it exists.
        background.add_task(builder.finish_provisioning, chat_["agent_id"], chat_["endpoint_name"], chat_["spec"], who)
    return out


@app.put("/api/admin/builder/genie/{space_id}")
def genie_update(space_id: str, payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return genie.update_space(space_id, genie.clean(payload), tok)


@app.delete("/api/admin/builder/genie/{space_id}")
def genie_delete(space_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return genie.delete_space(space_id, tok)


def _names(tok: str) -> dict:
    """Endpoint name -> the friendly name people know it by (cosmetic only)."""
    try:
        return {a["name"]: a["display_name"] for a in access.all_agents(tok)}
    except DbxError:
        return {}


@app.get("/api/dashboard/me")
def dashboard_me(days: int = 30, x_forwarded_access_token: str = Header(None)):
    """The signed-in person's own activity. The name comes from their token, never
    from the request, so nobody can ask for someone else's."""
    who, _ = _who(x_forwarded_access_token)
    return dashboard.activity(who["user_name"], days, _names(app_token()))


@app.get("/api/dashboard/me/insights")
def dashboard_me_insights(days: int = 30, x_forwarded_access_token: str = Header(None)):
    """When the signed-in person uses the assistants, and their files. Own data only:
    the name comes from their token, never from the request."""
    who, _ = _who(x_forwarded_access_token)
    return dashboard.insights(who["user_name"], days, _names(app_token()))


@app.get("/api/admin/dashboard/overview")
def dashboard_overview(days: int = 30, x_forwarded_access_token: str = Header(None)):
    """Adoption across the portal: active and new people, use per assistant. Counts only."""
    _require_admin(x_forwarded_access_token)
    return dashboard.org(days, _names(app_token()))


@app.get("/api/admin/dashboard/people")
def dashboard_people(days: int = 30, x_forwarded_access_token: str = Header(None)):
    _require_admin(x_forwarded_access_token)
    return dashboard.everyone(days)


@app.get("/api/admin/dashboard/person")
def dashboard_person(user: str, days: int = 30, x_forwarded_access_token: str = Header(None)):
    """Counts for one person, for admins. Never their questions or chat titles."""
    _require_admin(x_forwarded_access_token)
    if not user.strip() or len(user) > 200:
        raise HTTPException(400, "user is required")
    return dashboard.activity(user.strip(), days, _names(app_token()))


@app.get("/api/admin/dashboard/costs")
def dashboard_costs(days: int = 30, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return dashboard.costs(days, tok)


@app.get("/api/admin/builder/knowledge")
def knowledge_list(x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return {"assistants": knowledge.list_assistants(tok)}


@app.get("/api/admin/builder/knowledge/{ka_id}")
def knowledge_get(ka_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return knowledge.get_assistant(ka_id, tok)


@app.post("/api/admin/builder/knowledge")
def knowledge_create(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    who, tok = _require_admin(x_forwarded_access_token)
    spec = knowledge.clean(payload)
    out = knowledge.create(spec, who, tok)
    # Reading the documents takes minutes; tag and share the endpoint when it exists.
    background.add_task(knowledge.finish, out["ka_id"], spec, who)
    return out


@app.put("/api/admin/builder/knowledge/{ka_id}")
def knowledge_update(ka_id: str, payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    # Editing needs only the text fields; documents are changed in Databricks.
    spec = {
        "display_name": (payload.get("display_name") or "").strip(),
        "description": (payload.get("description") or "").strip(),
        "instructions": (payload.get("instructions") or "").strip(),
    }
    if not spec["display_name"] or not spec["description"]:
        raise HTTPException(400, "a name and a description are required")
    return knowledge.update_assistant(ka_id, spec, tok)


@app.delete("/api/admin/builder/knowledge/{ka_id}")
def knowledge_delete(ka_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return knowledge.delete_assistant(ka_id, tok)


@app.get("/api/admin/cost")
def llm_cost(days: int = 30, x_forwarded_access_token: str = Header(None)):
    """Actual model-serving spend, read from the workspace billing tables."""
    _who_admin, tok = _require_admin(x_forwarded_access_token)
    return llm.spend(tok, days)


@app.get("/api/admin/logs")
def recent_logs(
    days: int = 7, limit: int = 200, x_forwarded_access_token: str = Header(None)
):
    """Recent problems - failed API calls and their reasons.

    Read from the Delta table when PORTAL_LOG_TABLE is set, otherwise from this
    process's memory. Falls back to memory, with a note, if the table cannot be
    read, so a permissions slip cannot blank the panel.
    """
    _require_admin(x_forwarded_access_token)
    limit = 20 if limit < 20 else (500 if limit > 500 else limit)
    if logsink.enabled():
        try:
            return {"stored": True, "note": "", "lines": logsink.recent(days, limit)}
        except Exception as exc:
            note = "Could not read the log table, showing this session only. " + str(exc)[:200]
            return {"stored": False, "note": note, "lines": logbuf.buffer.recent(logging.WARNING, limit)}
    return {"stored": False, "note": "", "lines": logbuf.buffer.recent(logging.WARNING, limit)}


@app.get("/api/admin/audit")
def activity(
    days: int = 7,
    cats: str = "access",
    x_forwarded_access_token: str = Header(None),
):
    """Recent activity, from Databricks' own audit records."""
    _who_admin, user_tok = _require_admin(x_forwarded_access_token)
    wanted = [c.strip() for c in (cats or "").split(",") if c.strip()]
    return audit.entries(
        user_tok,
        app_token(),
        days=days,
        cats=wanted,
        workspace_id=os.environ.get("DATABRICKS_WORKSPACE_ID", "")
        or str(access.identity(user_tok).get("workspace_id") or ""),
    )


@app.get("/api/health")
def health():
    return {"ok": True, "auth_mode": auth_mode()}


# Mounted last on purpose: every /api route above is registered first and so
# still wins, while everything else falls through to the built UI.
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
