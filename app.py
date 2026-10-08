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

import json
import logging
import os
import re
import time

from fastapi import BackgroundTasks, Body, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

import access
import attachments
import audit
import builder
import chat
import genie
import knowledge
import chats
import connections
import dashboard
import designer
import events
import files as filestore
import forge
import llm
import logbuf
import logsink
import mcps
import tooltest
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
    # Routes that do something worth recording fill this in (events.note).
    rec = events.begin()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("%s %s user=%s -> unhandled error", request.method, request.url.path, _caller(request), **_ctx(request, 500))
        events.finish(rec, 500, int((time.monotonic() - start) * 1000), _caller(request))
        raise
    ms = int((time.monotonic() - start) * 1000)
    events.finish(rec, response.status_code, ms, _caller(request))
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
    events.failed(str(exc), exc.status)
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


@app.exception_handler(StarletteHTTPException)
async def _http_error(request: Request, exc: StarletteHTTPException):
    # Our own refusals ("You do not have access to that agent"): put the reason on
    # the activity record, then answer exactly as FastAPI would have.
    events.failed(str(exc.detail), exc.status_code)
    return await http_exception_handler(request, exc)


def _who(forwarded):
    """Resolve the caller. Fails closed if the OBO token is missing in Apps."""
    tok = user_token(forwarded)
    who = access.identity(tok)
    events.note(actor=who.get("user_name"))
    return who, tok


def _require_admin(forwarded):
    who, tok = _who(forwarded)
    if not who["is_admin"]:
        raise HTTPException(403, "Access administration is limited to workspace admins.")
    return who, tok


@app.get("/api/session")
def session(x_forwarded_access_token: str = Header(None)):
    who, _ = _who(x_forwarded_access_token)
    events.note(action="opened_portal")
    return {**who, "auth_mode": auth_mode(), "chat_history": chats.enabled(), "version": VERSION, "brand": BRAND}


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
    # Recorded for agent health: which assistant, how long, did it work. Never
    # the question or the answer.
    events.note(action="asked", target=endpoint, detail={"files": len(uploads)})
    # Confirm the agent is one this user may see before spending a call on it.
    # The invocation below still runs under the user's own token, so this check
    # is a courtesy for clearer errors, not the security boundary.
    agent = _allowed_agent(who, endpoint, tok)
    # `known`: the assistant exists and this person may use it, so the outcome
    # says something about the assistant. A refused or unknown name only says
    # something about the request, and stays out of per-assistant reliability.
    events.note(label=agent.get("display_name"), detail={"files": len(uploads), "known": True})
    output_dir = filestore.output_dir_path(agent["output_volume"]) if agent.get("output_volume") else ""
    out = chat.ask(endpoint, agent["task"], history, tok, files=uploads, output_dir=output_dir)
    # A reply can arrive fine while a tool inside it failed; count that too.
    broken = events.tool_failure(out.get("reply") or "")
    events.note(
        detail={"files": len(uploads), "known": True, "tools": (out.get("tools") or [])[:10], "files_back": len(out.get("attachments") or [])},
        **({"status": "tool_error", "error": broken} if broken else {}),
    )

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
    events.note(action="deleted_conversation")
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
    name = file.filename or "upload"
    events.note(action="uploaded", target=endpoint.strip(), detail={"name": name})
    agent = _allowed_agent(who, endpoint.strip(), tok)
    events.note(label=agent.get("display_name"))
    if not agent.get("upload_volume"):
        raise HTTPException(400, "This agent does not accept file uploads.")

    accepts = agent.get("accepts") or []
    if accepts and not any(name.lower().endswith("." + a.lstrip(".")) for a in accepts):
        raise HTTPException(
            400, "This agent accepts only: " + ", ".join("." + a.lstrip(".") for a in accepts)
        )

    blob = await file.read()
    events.note(detail={"name": name, "bytes": len(blob)})
    return filestore.upload(agent["upload_volume"], name, blob, tok)


@app.get("/api/download")
def download(
    endpoint: str,
    path: str,
    x_forwarded_access_token: str = Header(None),
):
    """Fetch a file an agent generated, as the signed-in user."""
    who, tok = _who(x_forwarded_access_token)
    events.note(action="downloaded", target=endpoint.strip(), detail={"name": path.rsplit("/", 1)[-1]})
    agent = _allowed_agent(who, endpoint.strip(), tok)
    events.note(label=agent.get("display_name"))
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
    events.note(
        action="granted" if level else "revoked",
        target=target.get("name") or endpoint_id,
        label=target.get("display_name"),
        detail={"principal": principal, "kind": kind, "level": level or ""},
    )
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
    events.note(action="created_team", target=name, label=name)
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
    events.note(action="changed_team", target=group_id, label=(payload.get("name") or group_id), detail={"members": len(users)})
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
    events.note(action="changed_settings", target=name, detail={"fields": sorted(values)})
    if not values:
        raise HTTPException(400, "nothing to update")
    tok = app_token()
    target = next((a for a in access.all_agents(tok) if a["name"] == name), None)
    if not target:
        raise HTTPException(404, "no such agent")
    events.note(label=target.get("display_name"))
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


def _folder_access(tools: list, volumes: dict, tok: str) -> list:
    """Bring the folder access of the assistant's running catalog tools up to date,
    before the assistant is handed back so the first chat cannot beat it. Never
    fails the save: what could not be granted comes back as warnings."""
    if not (volumes["read"] or volumes["write"]):
        return []
    try:
        ready = mcps.users_of_volumes(tools)
        return mcps.grant_volumes(ready, volumes, tok) if ready else []
    except DbxError as exc:
        return ["Could not give the tools access to the folders: " + str(exc)[:160]]


@app.get("/api/admin/builder/mcps")
def mcps_list(refresh: bool = False, x_forwarded_access_token: str = Header(None)):
    """The tool catalog from git, with what is already deployed as a Databricks App."""
    _, tok = _require_admin(x_forwarded_access_token)
    return mcps.listing(tok, refresh)


@app.post("/api/admin/builder/mcps/prepare")
def mcps_prepare(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    """Start getting ticked tools ready. The wizard waits for them (it watches the
    list above) and only then creates the assistant."""
    who, tok = _require_admin(x_forwarded_access_token)
    slugs = [str(s) for s in (payload.get("slugs") or []) if s]
    if not slugs or len(slugs) > 20:
        raise HTTPException(400, "choose between 1 and 20 tools")
    started = mcps.prepare(slugs, tok)
    for entry in started:
        background.add_task(mcps.install_quietly, entry, who, tok)
    return {"preparing": [e["name"] for e in started]}


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
    return _create_supervisor(builder.clean_spec(payload), who, tok, background)


def _create_supervisor(spec: dict, who: dict, tok: str, background: BackgroundTasks, via: str = "") -> dict:
    """Create a Supervisor Agent from a validated spec. Shared by the wizard and the
    assistant designer, so both follow the same rules."""
    events.note(action="created_assistant", label=spec.get("display_name"))
    # Catalog tools whose app is not running yet are installed after the agent
    # exists and added to it when ready; the rest are attached now.
    spec["tools"], pending = mcps.plan(spec["tools"], tok, derive=True)
    try:
        out = builder.create_agent(spec, who, tok)
    except DbxError as exc:
        # Databricks says an app we meant to attach is not there. Whatever made us
        # think it was is wrong, so install those instead and try once more.
        if exc.status != 404 or "does not exist" not in str(exc):
            raise
        spec["tools"], more = mcps.defer(spec["tools"])
        if not more:
            raise
        pending += more
        out = builder.create_agent(spec, who, tok)
    deploying = [p["entry"]["name"] for p in pending]
    events.note(action="created_assistant", label=spec.get("display_name"), detail={"type": "Combines tools", "tools": len(spec.get("tools") or []), "deploying": deploying, **({"via": via} if via else {})})
    events.note(target=out.get("endpoint_name") or out.get("agent_id"))
    volumes = mcps.volumes_for(spec)
    if pending:
        background.add_task(mcps.deploy_and_attach, out["agent_id"], pending, who, tok, volumes)
    # Tools that are already running only need their folder access brought up to date.
    out["warnings"] = list(out.get("warnings") or []) + _folder_access(spec["tools"], volumes, tok)
    out["deploying"] = deploying
    # The serving endpoint appears a few minutes later; tag and share it then.
    background.add_task(builder.finish_provisioning, out["agent_id"], out["endpoint_name"], spec, who)
    return out


@app.put("/api/admin/builder/agents/{agent_id}")
def builder_update(
    agent_id: str,
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    who, tok = _require_admin(x_forwarded_access_token)
    spec = builder.clean_spec(payload)
    spec["tools"], pending = mcps.plan(spec["tools"], tok)
    deploying = [p["entry"]["name"] for p in pending]
    events.note(action="edited_assistant", target=agent_id, label=spec.get("display_name"), detail={"type": "Combines tools", "deploying": deploying})
    out = builder.update_agent(agent_id, spec, who, tok)
    # Folder access follows the assistant's current folders, for tools attached earlier too.
    # (spec["tools"] holds the tools to attach now; ones already on the assistant are
    # recognised by their app name.)
    volumes = mcps.volumes_for(spec)
    if pending:
        background.add_task(mcps.deploy_and_attach, agent_id, pending, who, tok, volumes)
    out["warnings"] = list(out.get("warnings") or []) + _folder_access(mcps.as_catalog_tools(spec["tools"]), volumes, tok)
    out["deploying"] = deploying
    return out


@app.delete("/api/admin/builder/agents/{agent_id}")
def builder_delete(agent_id: str, x_forwarded_access_token: str = Header(None)):
    who, tok = _require_admin(x_forwarded_access_token)
    events.note(action="deleted_assistant", target=agent_id, detail={"type": "Combines tools"})
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
    return _create_genie(genie.clean(payload), who, tok, background)


def _create_genie(gspec: dict, who: dict, tok: str, background: BackgroundTasks, via: str = "") -> dict:
    events.note(action="created_assistant", label=gspec.get("title"), detail={"type": "Answers from data", **({"via": via} if via else {})})
    out = genie.create(gspec, who, tok)
    events.note(target=out.get("space_id"))
    chat_ = out.pop("_chat", None)
    if chat_:
        # Same follow-up as any supervisor: tag and share its endpoint once it exists.
        background.add_task(builder.finish_provisioning, chat_["agent_id"], chat_["endpoint_name"], chat_["spec"], who)
        out["endpoint_name"] = chat_["endpoint_name"]
    return out


@app.put("/api/admin/builder/genie/{space_id}")
def genie_update(space_id: str, payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    gspec = genie.clean(payload)
    events.note(action="edited_assistant", target=space_id, label=gspec.get("title"), detail={"type": "Answers from data"})
    return genie.update_space(space_id, gspec, tok)


@app.delete("/api/admin/builder/genie/{space_id}")
def genie_delete(space_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    events.note(action="deleted_assistant", target=space_id, detail={"type": "Answers from data"})
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
    return _create_knowledge(knowledge.clean(payload), who, tok, background)


def _create_knowledge(spec: dict, who: dict, tok: str, background: BackgroundTasks, via: str = "") -> dict:
    events.note(action="created_assistant", label=spec.get("display_name"), detail={"type": "Answers from documents", "folders": len(spec.get("sources") or []), **({"via": via} if via else {})})
    out = knowledge.create(spec, who, tok)
    events.note(target=out.get("ka_id"))
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
    events.note(action="edited_assistant", target=ka_id, label=spec["display_name"] or None, detail={"type": "Answers from documents"})
    if not spec["display_name"] or not spec["description"]:
        raise HTTPException(400, "a name and a description are required")
    return knowledge.update_assistant(ka_id, spec, tok)


@app.delete("/api/admin/builder/knowledge/{ka_id}")
def knowledge_delete(ka_id: str, x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    events.note(action="deleted_assistant", target=ka_id, detail={"type": "Answers from documents"})
    return knowledge.delete_assistant(ka_id, tok)


@app.get("/api/admin/designer/status")
def designer_status(x_forwarded_access_token: str = Header(None)):
    """Is the designer on, and which AI models can this admin choose from (read under their own token)."""
    _, tok = _require_admin(x_forwarded_access_token)
    return designer.status(tok)


@app.post("/api/admin/designer/files")
async def designer_attach(
    file: UploadFile = File(...),
    folder: str = Form(...),
    on_conflict: str = Form("ask"),
    x_forwarded_access_token: str = Header(None),
):
    """Attach a file while designing: saved to the folder the admin chose, as the admin
    (so Databricks decides where they may save). Key files are refused (use Connect)."""
    _, tok = _require_admin(x_forwarded_access_token)
    blob = await file.read()
    name = file.filename or "file"
    out = attachments.upload(folder, name, blob, tok, on_conflict if on_conflict in ("ask", "replace", "keep_both") else "ask")
    events.note(action="attached_file", label=out["name"], detail={"bytes": out["bytes"], "kind": out["kind"]})
    return out


@app.delete("/api/admin/designer/files")
def designer_detach(path: str, x_forwarded_access_token: str = Header(None)):
    """Remove a file attached a moment ago (before it was sent), as the admin."""
    _, tok = _require_admin(x_forwarded_access_token)
    attachments.remove(path, tok)
    return {"ok": True}


@app.get("/api/admin/designer/connections")
def designer_connections(names: str = "", x_forwarded_access_token: str = Header(None)):
    """Which of these connections are set. Names only; a value is never returned."""
    _, tok = _require_admin(x_forwarded_access_token)
    return {"connections": connections.status([n.strip() for n in names.split(",") if n.strip()][:20], tok)}


@app.put("/api/admin/designer/connections/{name}")
def designer_connect(name: str, payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """Save a credential a tool needs into the workspace's secret store. The value goes
    from this request to Databricks and nowhere else: never logged, never returned,
    never shown to an AI model."""
    _, tok = _require_admin(x_forwarded_access_token)
    out = connections.save(name, payload.get("value") or "", str(payload.get("kind") or ""), tok, bool(payload.get("replace")))
    events.note(action="saved_connection", label=out["name"], detail={"replaced": bool(payload.get("replace"))})
    return out


@app.post("/api/admin/designer/turn")
def designer_turn(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """One exchange of the interview. The browser holds the conversation and the
    draft and sends both each time; nothing is kept here, and what was typed is
    never logged."""
    who, tok = _require_admin(x_forwarded_access_token)
    return designer.turn(payload.get("messages") or [], payload.get("draft") or {}, tok, payload.get("models"),
                         owner=who.get("user_name") or "")


@app.get("/api/admin/designer/jobs/{job_id}")
def designer_job(job_id: str, x_forwarded_access_token: str = Header(None)):
    """How a new tool being written in the background is going; when done, the tool itself."""
    who, _ = _require_admin(x_forwarded_access_token)
    return designer.job(job_id, who.get("user_name") or "")


@app.post("/api/admin/designer/build")
def designer_build(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    """Approve: build the draft with the same code the wizards use. The draft came
    through the browser, so it is checked again here, whatever the model said."""
    who, tok = _require_admin(x_forwarded_access_token)
    if not designer.enabled():
        raise HTTPException(404, "The assistant designer is switched off.")
    draft = designer.clean_draft(payload.get("draft"))
    # Tools the designer proposed must already have been created (see tools/create).
    problems = designer.check(draft) or designer.verify(draft, tok, created=True)
    if problems:
        raise HTTPException(400, "It is not ready to build yet: " + " ".join(problems[:3]))
    kind = draft["kind"]
    if kind == "genie":
        out = _create_genie(genie.clean(designer.genie_payload(draft)), who, tok, background, via="designer")
    elif kind == "knowledge":
        out = _create_knowledge(knowledge.clean(designer.knowledge_payload(draft)), who, tok, background, via="designer")
    else:
        out = _create_supervisor(builder.clean_spec(designer.supervisor_payload(draft)), who, tok, background, via="designer")
    return {**out, "kind": kind, "name": draft["display_name"]}


@app.post("/api/admin/designer/tools/create")
def designer_tools_create(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    """Create the new tools a draft proposes, after the admin has read them.

    `approved` must be the fingerprints of exactly the tools being created, as the
    admin saw them. The draft came through the browser, so everything is checked
    again here; functions are created now (as the admin), apps are installed in
    the background and watched through tools/status.
    """
    who, tok = _require_admin(x_forwarded_access_token)
    if not designer.enabled():
        raise HTTPException(404, "The assistant designer is switched off.")
    draft = designer.clean_draft(payload.get("draft"))
    news = draft.get("new_tools") or []
    if not news:
        raise HTTPException(400, "There are no new tools to create.")
    problems = designer.check(draft) or designer.verify(draft, tok)
    if problems:
        raise HTTPException(400, "A new tool is not ready: " + " ".join(problems[:3]))
    if {str(x) for x in payload.get("approved") or []} != {n["fingerprint"] for n in news}:
        raise HTTPException(400, "Read and approve every new tool as it is shown now. It changed since you approved it.")
    events.note(action="created_tool", label=", ".join(forge.key_of(n) for n in news),
                detail={"via": "designer", "tools": [{"kind": n["kind"], "key": forge.key_of(n), "fingerprint": n["fingerprint"][:12]} for n in news]})
    results: list = []
    for n in news:  # functions first and in the request, so a refusal stops everything before an app is started
        if n["kind"] != "uc_function":
            continue
        try:
            results.append({"key": n["name"], "kind": "uc_function", **forge.create_function(n, draft.get("warehouse_id", ""), tok)})
        except DbxError as exc:
            made = [r["key"] for r in results]
            results.append({"key": n["name"], "kind": "uc_function", "created": False, "error": str(exc)[:300]})
            return JSONResponse({"results": results, "error": str(exc)[:300] + (
                " Already created: %s." % ", ".join(made) if made else "")}, status_code=400)
    today = time.strftime("%Y-%m-%d")
    for n in news:
        if n["kind"] == "mcp":
            mcps._progress[forge.app_name(n["slug"])] = {"phase": "copying", "message": "Getting it ready.", "at": time.time()}
            background.add_task(forge.install_app, n, who, tok, today)
            results.append({"key": n["slug"], "kind": "mcp", "app_name": forge.app_name(n["slug"]), "started": True})
    return {"results": results}


@app.get("/api/admin/designer/tools/status")
def designer_tools_status(apps: str = "", x_forwarded_access_token: str = Header(None)):
    """Where each new tool's app is up to: not started, getting ready, running or failed."""
    _, tok = _require_admin(x_forwarded_access_token)
    names = [a for a in apps.split(",") if re.match(r"^mcp-[a-z0-9][a-z0-9-]{0,60}$", a)][:5]
    return {"apps": forge.app_states(names, tok) if names else {}}


def _tool_slug(payload: dict) -> str:
    slug = str(payload.get("slug") or "").strip()
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,60}$", slug):
        raise HTTPException(400, "That is not a tool id.")
    return slug


@app.post("/api/admin/designer/tool-test/plan")
def designer_tooltest_plan(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """Write the calls to try a new tool with, from its real input shapes and the files that are
    really in its folders. Reads only; nothing is called yet."""
    _, tok = _require_admin(x_forwarded_access_token)
    if not designer.enabled():
        raise HTTPException(404, "The assistant designer is switched off.")
    slug = _tool_slug(payload)
    item = forge.item_from_workspace(slug, tok)
    tools = tooltest.connect(slug, tok).tools()
    return tooltest.plan(item, tools, tooltest.facts_for(item, tok), tok, payload.get("models"))


@app.post("/api/admin/designer/tool-test/run")
def designer_tooltest_run(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """Call one ability of a new tool, as an assistant would, and say what came back. Only a read-only
    ability can be run: the tool's own declaration is checked here, not taken from the request."""
    _, tok = _require_admin(x_forwarded_access_token)
    slug = _tool_slug(payload)
    forge.item_from_workspace(slug, tok)  # a tool the designer made, and nobody else's
    test = payload.get("test") if isinstance(payload.get("test"), dict) else {}
    client = tooltest.connect(slug, tok)
    tool = next((t for t in client.tools() if t.get("name") == test.get("ability")), None)
    if not tool:
        raise HTTPException(400, "That tool has no such ability.")
    if not tooltest._readonly(tool):
        raise HTTPException(400, "That ability saves or changes something, so it is not run automatically.")
    args = test.get("arguments") if isinstance(test.get("arguments"), dict) else {}
    if len(json.dumps(args)) > 2000:
        raise HTTPException(400, "That input is too large.")
    return tooltest.run_one(client, {"ability": tool["name"], "arguments": args, "expect": str(test.get("expect") or "")[:300],
                                     "expect_error": bool(test.get("expect_error"))}, tok, payload.get("models"))


@app.post("/api/admin/designer/tool-test/fix")
def designer_tooltest_fix(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """Have the code model repair a new tool after a failed test. Proposes only: the result (the new code,
    a diff, what changed, a fingerprint) is shown to the admin and nothing is deployed."""
    _, tok = _require_admin(x_forwarded_access_token)
    slug = _tool_slug(payload)
    item = forge.item_from_workspace(slug, tok)
    failures = [f for f in payload.get("failures") or [] if isinstance(f, dict)][:6]
    if not failures:
        raise HTTPException(400, "Say what failed.")
    out = tooltest.propose_fix(item, failures, tok, payload.get("models"))
    return {**out, "slug": slug, "name": item["name"]}


@app.post("/api/admin/designer/tool-test/apply")
def designer_tooltest_apply(
    background: BackgroundTasks,
    payload: dict = Body(...),
    x_forwarded_access_token: str = Header(None),
):
    """Deploy a repair the admin has read. The code comes back from the browser, so it is checked again
    as if it were new, and `approved` must be the fingerprint of exactly this code on this tool."""
    who, tok = _require_admin(x_forwarded_access_token)
    slug = _tool_slug(payload)
    current = forge.item_from_workspace(slug, tok)
    code = str(payload.get("code") or "")
    new = forge.clean_item({**current, "code": code}) or current
    if new["problems"]:
        raise HTTPException(400, "The repaired code did not pass the checks: " + " ".join(new["problems"][:2]))
    if code.strip() == current["code"].strip():
        raise HTTPException(400, "There is nothing to change.")
    if str(payload.get("approved") or "") != new["fingerprint"]:
        raise HTTPException(400, "Read and approve the repair as it is shown now. It changed since you approved it.")
    events.note(action="fixed_tool", label=slug, target=forge.app_name(slug),
                detail={"via": "designer", "fingerprint": new["fingerprint"][:12], "what": str(payload.get("what") or "")[:200]})
    # Stamped a few seconds early, because the deployment's own clock is Databricks' and this one is ours.
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 5))
    mcps._progress[forge.app_name(slug)] = {"phase": "copying", "message": "Applying the repair.", "at": time.time()}
    background.add_task(forge.install_app, new, who, tok, time.strftime("%Y-%m-%d"))
    return {"started": True, "app_name": forge.app_name(slug), "since": since}


@app.get("/api/admin/designer/tool-test/ready")
def designer_tooltest_ready(slug: str, since: str, x_forwarded_access_token: str = Header(None)):
    """Has a repair gone live yet? The old version keeps answering until the new one is in."""
    _, tok = _require_admin(x_forwarded_access_token)
    slug = _tool_slug({"slug": slug})
    if not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", since or ""):
        raise HTTPException(400, "since must be a time like 2026-10-08T12:00:00Z")
    return tooltest.deployed_since(slug, since, tok)


@app.post("/api/admin/designer/test-plan")
def designer_test_plan(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    _, tok = _require_admin(x_forwarded_access_token)
    return {"tests": designer.plan_tests(payload.get("draft") or {}, tok, payload.get("models"))}


@app.get("/api/admin/designer/assistant-state")
def designer_assistant_state(endpoint: str, x_forwarded_access_token: str = Header(None)):
    """Is the new assistant up yet? It takes a few minutes, and only appears here
    once it has been shared with the admin."""
    who, tok = _require_admin(x_forwarded_access_token)
    for a in access.visible_agents(who, app_token(), tok):
        if a["name"] == endpoint:
            return {"state": "ready" if a["ready"] else "starting"}
    return {"state": "waiting"}


@app.post("/api/admin/designer/test-run")
def designer_test_run(payload: dict = Body(...), x_forwarded_access_token: str = Header(None)):
    """Ask the new assistant one test question as the admin and have a second model
    mark the answer. A failure to answer is a result, not an error."""
    who, tok = _require_admin(x_forwarded_access_token)
    endpoint = (payload.get("endpoint") or "").strip()
    question = (payload.get("question") or "").strip()[:500]
    expect = (payload.get("expect") or "").strip()[:500]
    if not endpoint or not question:
        raise HTTPException(400, "an endpoint and a question are required")
    agent = _allowed_agent(who, endpoint, tok)
    if not agent["ready"]:
        raise HTTPException(409, "The assistant is still starting.")
    out_dir = filestore.output_dir_path(agent["output_volume"]) if agent.get("output_volume") else ""
    try:
        out = chat.ask(endpoint, agent["task"], [{"role": "user", "content": question}], tok, output_dir=out_dir)
    except DbxError as exc:
        return {"verdict": "fail", "reason": "It did not answer: " + str(exc)[:200], "answer": ""}
    broken = events.tool_failure(out.get("reply") or "")
    if broken:
        return {"verdict": "fail", "reason": "A tool it used failed: " + str(broken)[:200], "answer": (out.get("reply") or "")[:1500]}
    try:
        graded = designer.grade(question, expect, out.get("reply") or "", out.get("tools") or [], tok, payload.get("models"))
    except DbxError as exc:
        graded = {"verdict": "ungraded", "reason": "The checker could not run: " + str(exc)[:160]}
    return {**graded, "answer": (out.get("reply") or "")[:1500], "tools": (out.get("tools") or [])[:10]}


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


@app.get("/api/admin/activity")
def portal_activity(
    days: int = 7,
    category: str = "",
    status: str = "",
    actor: str = "",
    x_forwarded_access_token: str = Header(None),
):
    """What people did in the portal: actions, never what anyone typed."""
    _require_admin(x_forwarded_access_token)
    return events.activity(days, category.strip(), status.strip(), actor.strip())


@app.get("/api/admin/agent-health")
def agent_health(days: int = 7, x_forwarded_access_token: str = Header(None)):
    """Each assistant's failure rate, response time and recent problems."""
    _require_admin(x_forwarded_access_token)
    return events.health(days)


def _version() -> str:
    """The release this copy runs, from the VERSION file the deployer writes
    into each release (empty when run from a checkout)."""
    try:
        with open(os.path.join(HERE, "VERSION"), encoding="utf-8") as f:
            return f.read().strip()[:40]
    except OSError:
        return ""


VERSION = _version()

# A client's branding, set by the deployer: PORTAL_BRAND_NAME and
# PORTAL_BRAND_COLOR in app.yaml, and the logo as branding/logo.png in the
# release (always a PNG: the deployer converts uploads, so no SVG with script
# is ever served from the portal's own origin). All optional; unbranded = the
# default name and teal. The UI turns the colour into a palette (lib/brand.ts).
LOGO = os.path.join(HERE, "branding", "logo.png")


def _brand() -> dict:
    color = (os.environ.get("PORTAL_BRAND_COLOR") or "").strip()
    logo = ""
    if os.path.isfile(LOGO):
        logo = "/api/brand/logo?v=%d" % int(os.path.getmtime(LOGO))
    return {
        "name": (os.environ.get("PORTAL_BRAND_NAME") or "").strip()[:40],
        "color": color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "",
        "logo": logo,
    }


BRAND = _brand()


@app.get("/api/brand/logo")
def brand_logo():
    if not BRAND["logo"]:
        raise HTTPException(404, "No logo")
    with open(LOGO, "rb") as f:
        body = f.read()
    return Response(body, media_type="image/png", headers={
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


_shared: dict = {}


def _assistants_shared() -> int | None:
    """How many assistants the portal's own identity can see, i.e. have been
    shared with it. Zero means an empty portal for everyone, which the
    deployer's health check reports. Cached a minute; None if unknown."""
    hit = _shared.get("n")
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        n = len(access.all_agents(app_token()))
    except Exception:  # noqa: BLE001 - health must answer even if Databricks does not
        n = None
    _shared["n"] = (time.time() + 60, n)
    return n


@app.get("/api/health")
def health():
    out = {"ok": True, "auth_mode": auth_mode(), "version": VERSION}
    n = _assistants_shared()
    if n is not None:
        out["assistants"] = n
    return out


# Mounted last on purpose: every /api route above is registered first and so
# still wins, while everything else falls through to the built UI.
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
