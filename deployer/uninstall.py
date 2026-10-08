"""Take the portal out of a client's workspace, when the client is removed from
the deployer. Runs in the deploy job (action `uninstall`), as the client's own
service principal.

Removed: the portal app (its own service principal and permissions go with
it), every tool app the portal installed (an app whose code comes from
`/Workspace/Shared/agent-portal-mcps/`), the `agent-portal` secret scope (tool
secrets such as the Google Ad Manager key), the release folders and the tool
code folder; and, only when asked, the portal's chat history, activity and
problem tables.

Kept: assistants. They are the client's own Databricks assistants (also usable
outside the portal), and nothing marks which ones were built through it. The
installer's service principal is the client admin's to delete.

Each step is best effort and idempotent: something already gone is fine, a
refusal is reported, and a run can simply be repeated.
"""
from __future__ import annotations

from common import TABLE_RE, Api, DeployError
import workspace as ws

TOOLS_DIR = "/Workspace/Shared/agent-portal-mcps"
HISTORY_TABLES = ("portal_logs", "portal_chats", "portal_events")


def _gone(exc: DeployError) -> bool:
    s = str(exc)
    return exc.status == 404 or "RESOURCE_DOES_NOT_EXIST" in s or "does not exist" in s or "doesn't exist" in s


def _apps(api: Api) -> list[dict]:
    out, token = [], ""
    while True:
        page = api.call("GET", "/api/2.0/apps", params={"page_size": 100, **({"page_token": token} if token else {})}) or {}
        out += page.get("apps") or []
        token = page.get("next_page_token") or ""
        if not token:
            return out


def _source(app: dict) -> str:
    for k in ("active_deployment", "pending_deployment"):
        p = (app.get(k) or {}).get("source_code_path") or ""
        if p:
            return p
    return app.get("default_source_code_path") or ""


def tool_apps(apps: list[dict]) -> list[str]:
    """Apps the portal installed as tools: their code is in its tools folder."""
    return sorted(a["name"] for a in apps if _source(a).startswith(TOOLS_DIR + "/"))


def other_portals(apps: list[dict], app: str) -> list[str]:
    """Other portal apps in the same workspace (their code is a deployer release
    folder). Tools, tool keys and the tools folder are shared, so they stay
    while another portal uses them."""
    return sorted(a["name"] for a in apps if a.get("name") != app and "/agent-portal/" in _source(a)
                  and not _source(a).startswith(TOOLS_DIR + "/"))


def run(api: Api, c: dict, say, history: bool = False) -> tuple[list[str], list[str]]:
    """Returns (what was removed, problems), as plain sentences."""
    done: list[str] = []
    problems: list[str] = []

    def attempt(what: str, method: str, path: str, **kw) -> None:
        try:
            api.call(method, path, **kw)
            done.append(what)
        except DeployError as exc:
            if not _gone(exc):
                problems.append("Could not remove %s: %s" % (what, exc))

    say("Removing the portal app %s" % c["app"])
    attempt("the portal app %s" % c["app"], "DELETE", "/api/2.0/apps/" + c["app"])

    try:
        apps = _apps(api)
    except DeployError as exc:
        apps = None
        problems.append("Could not list the apps, so the tools were not removed: %s" % exc)
    others = other_portals(apps or [], c["app"])
    shared = apps is not None and not others
    if others:
        done.append("nothing shared: tools and tool keys stay for %s" % ", ".join(others))
    if shared:
        say("Removing the tools the portal installed")
        for name in tool_apps(apps):
            attempt("the tool app %s" % name, "DELETE", "/api/2.0/apps/" + name)
        say("Removing the tool secrets")
        attempt("the secret scope %s (tool keys such as Google Ad Manager)" % ws.TOOL_SCOPE, "POST",
                "/api/2.0/secrets/scopes/delete", json={"scope": ws.TOOL_SCOPE})

    say("Removing the portal's files")
    attempt("the portal's release folders", "POST", "/api/2.0/workspace/delete",
            json={"path": "/Workspace/Users/%s/agent-portal/%s" % (c["client_id"], c["app"]), "recursive": True})
    if shared:
        attempt("the tools' code folder", "POST", "/api/2.0/workspace/delete", json={"path": TOOLS_DIR, "recursive": True})

    if history and c.get("log_table"):
        if not TABLE_RE.match(c["log_table"]):
            problems.append("The history table name %r is not valid; nothing was dropped." % c["log_table"])
        else:
            say("Deleting the chat history and logs")
            schema = c["log_table"].rsplit(".", 1)[0]
            quoted = ".".join("`%s`" % part for part in schema.split("."))  # names may hold dashes
            try:
                warehouse = ws.pick_warehouse(api, c.get("warehouse") or "")
                for t in HISTORY_TABLES:
                    ws.sql(api, warehouse, "DROP TABLE IF EXISTS %s.`%s`" % (quoted, t))
                done.append("the chat history and logs in %s" % schema)
            except DeployError as exc:
                problems.append("Could not delete the chat history in %s: %s" % (schema, exc))
    return done, problems
