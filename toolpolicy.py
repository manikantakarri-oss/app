"""Which tool calls a person must approve before they run.

A Databricks MCP tool reaches the portal as an `mcp_approval_request` (tool name and its
server, which for an app tool is the app's name) and does not run until it is answered.
The portal used to answer every one with "approve", as Playground does, so nothing an
agent did ever waited for a person, including recording an approval or saving a final plan.

Now each request is checked against the tool's own declaration: MCP tools publish
`readOnlyHint` in `tools/list` (portal-made tools always do; seen live 2026-10-11 on the
DataBeat Media Planner's 31 tools: lookups read-only, saving / approving / finalising not).
A read-only tool runs at once; anything else waits for the person in the chat. Works for
any agent with no code per agent. Per assistant, the endpoint tag `tool_approval` can say
`auto` (never ask, the default), `all` (ask for every tool) or `changes` (ask only for tools
that change something).
A tool whose declaration cannot be read is treated as one that changes things: asking once
too often is better than running something unseen.
"""
from __future__ import annotations

import logging
import time

from builder import act
from dbx import DbxError, app_token

log = logging.getLogger("portal.toolpolicy")

MODES = ("changes", "all", "auto")
DEFAULT = "auto"  # no tag = the old behaviour; an assistant opts in to being asked with `changes` or `all`
TTL = 300
_cache: dict = {}  # server label -> (time, {tool: {"read_only": bool, "description": str}} | None)


def mode_of(tag: str) -> str:
    t = (tag or "").strip().lower()
    return t if t in MODES else DEFAULT


def tools_of(server: str, user_tok: str) -> dict | None:
    """{tool: {read_only, description}} as the server declares them, or None if unreadable."""
    hit = _cache.get(server)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    found = None
    try:
        app, _ = act("GET", "/api/2.0/apps/" + server, user_tok, quiet=True)
        url = (app or {}).get("url") or ""
    except DbxError:
        url = ""
    if url:
        import tooltest  # late: tooltest imports designer, which is heavy

        for tok in dict.fromkeys(t for t in (user_tok, _portal()) if t):
            try:
                listed = tooltest.Client(url, tok).open().tools()
            except DbxError:
                continue
            found = {t.get("name"): {"read_only": bool((t.get("annotations") or {}).get("readOnlyHint")),
                                     "description": str(t.get("description") or "")[:400]} for t in listed if t.get("name")}
            break
    if found is None:
        log.info("tool server %s: could not read its tool list; its tools will be asked about", server)
    _cache[server] = (time.time(), found)
    return found


def _portal() -> str:
    try:
        return app_token()
    except Exception:  # noqa: BLE001
        return ""


def needs_person(request: dict, mode: str, user_tok: str) -> bool:
    if mode == "auto":
        return False
    if mode == "all":
        return True
    declared = tools_of(str(request.get("server_label") or ""), user_tok) or {}
    return not (declared.get(request.get("name")) or {}).get("read_only", False)


def describe(request: dict, user_tok: str) -> dict:
    """What the person is shown for one request."""
    import json

    try:
        args = json.loads(request.get("arguments") or "{}")
    except ValueError:
        args = {"input": str(request.get("arguments") or "")[:2000]}
    info = (tools_of(str(request.get("server_label") or ""), user_tok) or {}).get(request.get("name")) or {}
    return {"id": request.get("id"), "tool": request.get("name") or "", "server": request.get("server_label") or "",
            "description": info.get("description", ""), "read_only": bool(info.get("read_only")),
            "arguments": args if isinstance(args, dict) else {"input": args}}
