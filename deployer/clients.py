"""What the deployer UI shows and does for each client, built from GitHub (the
client's settings, its secret's date, releases, job runs) and the deployment
record (versions, deploys, health). Route handlers in app.py stay thin.
"""
from __future__ import annotations

import datetime as dt
import re
import uuid

import ghub
import registry
from common import (APP_RE, CLIENT_RE, COLOR_RE, GROUP_RE, ID_RE, TABLE_RE, VERSION_RE, WAREHOUSE_RE, Api, DeployError,
                    check_logo, host, m2m_token)

SECRET = "DATABRICKS_CLIENT_SECRET"
# How long a deploy may sit in "requested" before we say GitHub never started it.
START_GRACE = dt.timedelta(minutes=10)
UUIDISH = r"^[0-9a-fA-F-]{8,64}$"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _ts(v) -> dt.datetime | None:
    if not v:
        return None
    s = str(v).replace("Z", "+00:00").replace(" ", "T")
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def pretty(env: str) -> str:
    return env[len("client-"):].replace("-", " ").title()


# --- validation -------------------------------------------------------------

def clean(payload: dict, *, new: bool) -> dict:
    """Check what the form sent. Raises DeployError(400) with a plain message."""
    out: dict = {}
    if new:
        slug = (payload.get("slug") or "").strip().lower()
        env = "client-" + slug
        if not CLIENT_RE.match(env):
            raise DeployError("The short name may use lowercase letters, digits and dashes (2-39 characters).")
        out["env"] = env
    name = (payload.get("name") or "").strip()
    if new and not name:
        raise DeployError("Give the client a name.")
    if len(name) > 80:
        raise DeployError("The name is too long (80 characters at most).")
    if name:
        out["CLIENT_NAME"] = name
    if "host" in payload or new:
        out["DATABRICKS_HOST"] = host(payload.get("host") or "")
        if not out["DATABRICKS_HOST"]:
            raise DeployError("Enter the client's workspace address.")
    if "client_id" in payload or new:
        cid = (payload.get("client_id") or "").strip()
        if not re.match(UUIDISH, cid):
            raise DeployError("The service principal's application id looks wrong (it is a long id with dashes).")
        out["DATABRICKS_CLIENT_ID"] = cid
    if "app_name" in payload or new:
        app = (payload.get("app_name") or "agent-portal").strip()
        if not APP_RE.match(app):
            raise DeployError("The app name may use lowercase letters, digits and dashes (2-30 characters).")
        out["APP_NAME"] = app
    if "log_table" in payload:
        t = (payload.get("log_table") or "").strip()
        if t and not TABLE_RE.match(t):
            raise DeployError("Where history is kept must be catalog.schema.table, for example main.agent_portal.portal_logs.")
        out["PORTAL_LOG_TABLE"] = t
    if "warehouse_id" in payload:
        w = (payload.get("warehouse_id") or "").strip()
        if w and not WAREHOUSE_RE.match(w):
            raise DeployError("The SQL warehouse id is 16 letters and digits (from the warehouse's page).")
        out["WAREHOUSE_ID"] = w
    if "users_group" in payload:
        g = (payload.get("users_group") or "").strip()
        if g and g.lower() not in ("-", "none") and not GROUP_RE.match(g):
            raise DeployError("That group name is not valid.")
        out["USERS_GROUP"] = g
    if "share_agents" in payload:
        # Stored only when switched off; empty (the default) means share them.
        out["SHARE_AGENTS"] = "" if payload.get("share_agents") in (True, "true", "all", "") else "none"
    out.update(clean_brand(payload))
    secret = (payload.get("secret") or "").strip()
    if new and not secret:
        raise DeployError("Enter the service principal's secret.")
    if secret:
        out[SECRET] = secret
    return out




def clean_brand(payload: dict) -> dict:
    """Branding fields from the form; only those present are returned, and an
    empty value removes that one. The logo must be a small PNG data URL: the
    UI converts every upload (SVG included) to PNG, so the portal never
    serves an SVG that could carry script."""
    out: dict = {}
    if "brand_name" in payload:
        name = (payload.get("brand_name") or "").strip()
        if len(name) > 40:
            raise DeployError("The portal name is too long (40 characters at most).")
        out["BRAND_NAME"] = name
    if "brand_color" in payload:
        color = (payload.get("brand_color") or "").strip()
        if color and not COLOR_RE.match(color):
            raise DeployError("The brand colour must look like #1A73E8.")
        out["BRAND_COLOR"] = color.lower()
    if "brand_logo" in payload:
        logo = (payload.get("brand_logo") or "").strip()
        if logo:
            check_logo(logo)
        out["BRAND_LOGO"] = logo
    return out


# --- reading ----------------------------------------------------------------

def _view(env: str, v: dict, deploys: list[dict], health: dict | None, current: str) -> dict:
    live = [d for d in deploys if d["status"] not in registry.FINAL]
    last = deploys[0] if deploys else None
    return {
        "id": env,
        "name": v.get("CLIENT_NAME") or pretty(env),
        "host": v.get("DATABRICKS_HOST", ""),
        "client_id": v.get("DATABRICKS_CLIENT_ID", ""),
        "app_name": v.get("APP_NAME") or "agent-portal",
        "log_table": v.get("PORTAL_LOG_TABLE", ""),
        "warehouse_id": v.get("WAREHOUSE_ID", ""),
        "users_group": v.get("USERS_GROUP", ""),
        "share_agents": (v.get("SHARE_AGENTS") or "").lower() != "none",
        "brand_name": v.get("BRAND_NAME", ""),
        "brand_color": v.get("BRAND_COLOR", ""),
        "brand_logo": v.get("BRAND_LOGO", ""),
        "ready": bool(v.get("DATABRICKS_HOST") and v.get("DATABRICKS_CLIENT_ID")),
        "version": current,
        "last_deploy": last,
        "in_progress": live[0] if live else None,
        "health": health,
    }


def list_all() -> dict:
    envs = ghub.clients()
    note = ""
    try:
        deploys = registry.latest_deploys(limit=500)
        healths = {h["client"]: h for h in registry.latest_health()}
    except DeployError as exc:
        deploys, healths, note = [], {}, "The deployment record could not be read: %s" % exc
    current = {}
    for d in deploys:
        if d["status"] == "succeeded" and d["client"] not in current:
            current[d["client"]] = d["version"]
    out = []
    for env in envs:
        mine = [d for d in deploys if d["client"] == env]
        out.append(_view(env, ghub.variables(env), mine, healths.get(env), current.get(env, "")))
    return {"clients": out, "note": note, "repo": ghub.repo(), "actions_url": ghub.actions_url()}


def detail(env: str) -> dict:
    if env not in ghub.clients():
        raise DeployError("There is no client %s." % env, 404)
    v = ghub.variables(env)
    deploys = registry.latest_deploys(env, 100)
    health = registry.latest_health(env, 30)
    current = next((d["version"] for d in deploys if d["status"] == "succeeded"), "")
    view = _view(env, v, deploys, health[0] if health else None, current)
    view["secret_set_at"] = ghub.secret_set(env, SECRET)
    return {**view, "deploys": deploys, "checks": health}


# --- connection test --------------------------------------------------------

def test(payload: dict, *, http_api=Api) -> dict:
    """Sign in as the client's service principal and look around, without
    changing anything. Returns checks a person can read."""
    h = host(payload.get("host") or "")
    cid = (payload.get("client_id") or "").strip()
    secret = (payload.get("secret") or "").strip()
    if not (h and cid and secret):
        raise DeployError("Enter the workspace address, the application id and the secret to test them.")
    checks = []
    api = http_api(h, m2m_token(h, cid, secret))
    checks.append({"label": "Signed in as the service principal", "ok": True, "detail": ""})
    me = api.call("GET", "/api/2.0/preview/scim/v2/Me")
    groups = {g.get("display") for g in me.get("groups") or []}
    admin = "admins" in groups
    checks.append({"label": "Workspace admin", "ok": admin,
                   "detail": "" if admin else "Add the service principal to the workspace admins group, or the deploy "
                                              "cannot set up access, and health checks cannot read errors."})
    app_name = (payload.get("app_name") or "agent-portal").strip()
    try:
        api.call("GET", "/api/2.0/apps", params={"page_size": 1})
        existing = api.call("GET", "/api/2.0/apps/" + app_name, quiet_404=True) if APP_RE.match(app_name) else None
        checks.append({"label": "Databricks Apps available", "ok": True,
                       "detail": ("An app named %s exists and will be updated." % app_name) if existing
                       else ("A new app named %s will be created." % app_name)})
    except DeployError as exc:
        checks.append({"label": "Databricks Apps available", "ok": False, "detail": str(exc)})
    try:
        whs = api.call("GET", "/api/2.0/sql/warehouses").get("warehouses") or []
        checks.append({"label": "SQL warehouse", "ok": bool(whs),
                       "detail": "%d available" % len(whs) if whs else "None the service principal can use; chat history needs one."})
    except DeployError as exc:
        checks.append({"label": "SQL warehouse", "ok": False, "detail": str(exc)})
    table = (payload.get("log_table") or "").strip()
    if table and TABLE_RE.match(table):
        cat = table.split(".")[0]
        got = api.call("GET", "/api/2.1/unity-catalog/catalogs/" + cat, quiet_404=True)
        checks.append({"label": "Catalog %s" % cat, "ok": got is not None,
                       "detail": "" if got is not None else "Not found, or the service principal cannot see it."})
    # The catalogs this login can see, so the form offers real names instead
    # of a guess (system and Databricks' own catalogs left out).
    catalogs: list[str] = []
    try:
        for page in range(10):
            d = api.call("GET", "/api/2.1/unity-catalog/catalogs", params={"max_results": 200, **({"page_token": token} if page else {})}) or {}
            catalogs += [c.get("name", "") for c in d.get("catalogs") or []]
            token = d.get("next_page_token") or ""
            if not token:
                break
    except DeployError:
        catalogs = []
    hidden = {"system", "samples", "hive_metastore", "__databricks_internal"}
    catalogs = sorted({c for c in catalogs if c and c not in hidden and not c.startswith("__")}, key=str.lower)
    access = {c: catalog_access(api, c, cid, admin) for c in catalogs[:40]}
    return {"ok": all(c["ok"] for c in checks), "checks": checks, "who": me.get("displayName") or me.get("userName") or cid,
            "catalogs": catalogs, "catalog_access": access}


def catalog_access(api, catalog: str, sp: str, admin: bool) -> str:
    """Can this login create the history schema in `catalog`? "ready",
    "needs_grant" or "unknown". Seen live: a catalog owned by the workspace
    admins group (the default `workspace` catalog) lists no effective
    privileges for an admin service principal, yet ownership through the group
    lets it create schemas; a catalog where it only has USE_CATALOG does not."""
    try:
        info = api.call("GET", "/api/2.1/unity-catalog/catalogs/" + catalog) or {}
        owner = info.get("owner") or ""
        if owner == sp or (admin and owner.startswith("_workspace_admins")):
            return "ready"
        eff = api.call("GET", "/api/2.1/unity-catalog/effective-permissions/catalog/" + catalog, params={"principal": sp}) or {}
        privs = {p.get("privilege") for a in eff.get("privilege_assignments") or [] for p in a.get("privileges") or []}
        if "ALL_PRIVILEGES" in privs or {"USE_CATALOG", "CREATE_SCHEMA"} <= privs:
            return "ready"
        return "needs_grant"
    except DeployError:
        return "unknown"


# --- changing ---------------------------------------------------------------

def create(payload: dict) -> dict:
    vals = clean(payload, new=True)
    env = vals.pop("env")
    if env in ghub.clients():
        raise DeployError("A client with the short name %s already exists." % env[len("client-"):], 409)
    secret = vals.pop(SECRET)
    ghub.create(env)
    ghub.set_vars(env, vals, have={})
    ghub.set_secret(env, SECRET, secret)
    return {"id": env}


def update(env: str, payload: dict) -> dict:
    if env not in ghub.clients():
        raise DeployError("There is no client %s." % env, 404)
    vals = clean(payload, new=False)
    secret = vals.pop(SECRET, "")
    ghub.set_vars(env, vals)
    if secret:
        ghub.set_secret(env, SECRET, secret)
    return {"id": env}


def remove(env: str) -> None:
    if env not in ghub.clients():
        raise DeployError("There is no client %s." % env, 404)
    ghub.remove(env)


def _in_flight(env: str) -> dict | None:
    for d in registry.latest_deploys(env, 20):
        if d["status"] not in registry.FINAL:
            started = _ts(d.get("started") or d.get("at"))
            if started and _now() - started < dt.timedelta(hours=1):
                return d
    return None


def start(env: str, version: str, action: str, actor: str) -> dict:
    """Ask GitHub to deploy `version` to the client. Recorded first, so the
    request is on file even if GitHub never starts the job."""
    if not CLIENT_RE.match(env) or env not in ghub.clients():
        raise DeployError("There is no client %s." % env, 404)
    if action not in ("deploy", "rollback"):
        raise DeployError("Unknown action.")
    v = ghub.variables(env)
    if not (v.get("DATABRICKS_HOST") and v.get("DATABRICKS_CLIENT_ID")) or not ghub.secret_set(env, SECRET):
        raise DeployError("This client's settings are incomplete. Add its workspace address, application id and secret.", 409)
    current = next((d["version"] for d in registry.latest_deploys(env, 200) if d["status"] == "succeeded"), "")
    if action == "rollback" and not version:
        version = registry.last_good(env, other_than=current)
        if not version:
            raise DeployError("There is no earlier version to roll back to.", 409)
    if not VERSION_RE.match(version or ""):
        raise DeployError("Choose a version.")
    if version not in {r["version"] for r in ghub.releases()}:
        raise DeployError("%s is not a published release." % version, 404)
    busy = _in_flight(env)
    if busy:
        raise DeployError("%s is already being deployed to this client. Wait for it to finish." % busy["version"], 409)
    deploy_id = str(uuid.uuid4())
    registry.record(deploy_id, env, action=action, version=version, from_version=current, status="requested",
                    step="Waiting for GitHub to start the job", actor=actor)
    try:
        ghub.dispatch("deploy.yml", {"client": env, "version": version, "action": action, "deploy_id": deploy_id,
                                     "actor": actor})
    except DeployError as exc:
        registry.safe(registry.record, deploy_id, env, action=action, version=version, from_version=current,
                      status="failed", step="GitHub did not start the job", message=str(exc), actor=actor)
        raise
    return {"deploy_id": deploy_id, "version": version}


def status(deploy_id: str) -> dict:
    """A deploy's steps, reconciled with GitHub: a job that ended without
    finishing its record is recorded as failed, so nothing hangs forever."""
    if not ID_RE.match(deploy_id):
        raise DeployError("Unknown deploy.", 404)
    steps = registry.steps(deploy_id)
    if not steps:
        raise DeployError("Unknown deploy.", 404)
    last = steps[-1]
    run = None
    if last["status"] not in registry.FINAL:
        try:
            run = ghub.find_run("deploy.yml", deploy_id)
        except DeployError:
            run = None
        ended = run and run["status"] == "completed"
        stale = not run and (_now() - (_ts(steps[0]["at"]) or _now())) > START_GRACE
        if ended or stale:
            why = ("The GitHub job ended (%s) before it finished the deploy." % run["conclusion"]) if ended else \
                "GitHub did not start the job. Check the repository's Actions settings and the client's environment."
            registry.safe(registry.record, deploy_id, last["client"], action=last["action"], version=last["version"],
                          from_version=last.get("from_version") or "", status="failed", step="Stopped", message=why,
                          actor=last.get("actor") or "", run_url=(run or {}).get("url") or last.get("run_url") or "")
            steps = registry.steps(deploy_id) or steps
    return {"steps": steps, "current": steps[-1], "run": run}


def check_now(env: str, actor: str) -> dict:
    if not CLIENT_RE.match(env) or env not in ghub.clients():
        raise DeployError("There is no client %s." % env, 404)
    check_id = str(uuid.uuid4())
    ghub.dispatch("health.yml", {"client": env, "check_id": check_id, "actor": actor})
    return {"check_id": check_id}


def check_result(env: str, check_id: str) -> dict:
    if not ID_RE.match(check_id):
        raise DeployError("Unknown check.", 404)
    for h in registry.latest_health(env, 30):
        if h["check_id"] == check_id:
            return {"done": True, "check": h}
    try:
        run = ghub.find_run("health.yml", check_id)
    except DeployError:
        run = None
    if run and run["status"] == "completed":
        return {"done": True, "check": None, "error": "The check job ended (%s) without a result." % run["conclusion"],
                "run": run}
    return {"done": False, "run": run}


def releases() -> dict:
    rel = ghub.releases()
    try:
        on = registry.current_versions()
    except DeployError:
        on = {}
    for r in rel:
        r["clients"] = sorted(e for e, v in on.items() if v == r["version"])
    return {"releases": rel, "repo": ghub.repo()}
