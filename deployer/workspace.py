"""Everything the deployer does inside a client's workspace, as that client's
service principal. Used by `deploy.py` and `health.py` (run in GitHub Actions).

Behaviour these steps rely on, learnt running the portal itself (see the
portal's README "Deploy from scratch" and mcps.py):
- An app's compute must be ACTIVE before a deployment is accepted; Databricks
  answers `Cannot deploy app ... as it is not in RUNNING state` otherwise.
- User API scopes are not applied from app.yaml. They are set on the app record,
  and the runtime keeps minting user tokens from the scopes it booted with, so a
  scope change needs a stop/start.
- Each version is uploaded to its own folder under the service principal's home,
  `/Workspace/Users/<sp-id>/agent-portal/<app>/<version>`, and the folder name is
  the version. The app's active deployment therefore says which version is live
  (`source_code_path`), straight from Databricks, and the previous version's
  folder is still there to roll back to.

Unconfirmed (written from the API reference, not yet run against a client):
reaching the app's own `/api/health` with the service principal's OAuth token.
If the app refuses that token, the check falls back to Databricks' view of the
app (running, deployment succeeded) and says the inside check was skipped.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

import httpx

from common import (APP_RE, GROUP_RE, TABLE_RE, TIMEOUT, VERSION_RE, WAREHOUSE_RE, Api, DeployError, wait)

APPS = "/api/2.0/apps"
# The portal files that make up a release. Everything else in the repo (tests,
# the UI source, the deployer itself) stays out of the client's workspace.
SHIP_EXCLUDE = re.compile(r"^(test_.*|smoke\.sh|sync_agents\.py|README\.md|TESTING\.md|CLAUDE\.md|\..*|ui|deployer|__pycache__)$")


def release_path(sp_id: str, app: str, version: str) -> str:
    return "/Workspace/Users/%s/agent-portal/%s/%s" % (sp_id, app, version)


def version_of(path: str) -> str:
    """The version a source folder holds (its last segment), or ''."""
    last = (path or "").rstrip("/").rsplit("/", 1)[-1]
    return last if VERSION_RE.match(last) else ""


# --- the app ----------------------------------------------------------------

def get_app(api: Api, name: str) -> dict | None:
    return api.call("GET", APPS + "/" + name, quiet_404=True)


def ensure_app(api: Api, name: str, scopes: list[str], say) -> tuple[dict, bool]:
    """The app, created if missing, with its compute running. Returns (app, created)."""
    if not APP_RE.match(name):
        raise DeployError("App name %r is not allowed: 2-30 lowercase letters, digits and dashes." % name)
    app = get_app(api, name)
    created = False
    if app is None:
        say("Creating the app %s" % name)
        api.call("POST", APPS, json={"name": name, "description": "Agent Portal: your team's AI assistants",
                                     "user_api_scopes": scopes})
        created = True
    return wait_active(api, name, say), created


def wait_active(api: Api, name: str, say, timeout: float = 600, **kw) -> dict:
    """Wait for the app's compute to be ACTIVE, starting it if it is stopped."""
    started = [False]

    def check():
        app = get_app(api, name) or {}
        state = (app.get("compute_status") or {}).get("state", "")
        if state == "ACTIVE":
            return app
        if state in ("STOPPED", "ERROR") and not started[0]:
            say("Starting the app's compute (it was %s)" % state.lower())
            api.call("POST", APPS + "/" + name + "/start")
            started[0] = True
        if state == "DELETING":
            raise DeployError("The app %s is being deleted in that workspace. Try again in a few minutes." % name, 409)
        return None

    app = wait(check, timeout, **kw)
    if not app:
        raise DeployError("The app's compute did not start within %d minutes." % (timeout // 60), 504)
    return app


def set_scopes(api: Api, name: str, app: dict, scopes: list[str], say) -> bool:
    """Put the user API scopes on the app record. True when they changed (a
    restart is then needed for them to take effect)."""
    # Compare with what was requested, not the effective list: seen live (AWS,
    # 2026-10-06) the effective list adds the default iam.* scopes and folds
    # sql.statement-execution / sql.warehouses into "sql", so it never equals
    # the request, and every deploy restarted the app for nothing.
    have = sorted(app.get("user_api_scopes") or app.get("effective_user_api_scopes") or [])
    if have == sorted(scopes):
        return False
    say("Updating what the app may do for signed-in people (%d permissions)" % len(scopes))
    api.call("PATCH", APPS + "/" + name, json={"name": name, "user_api_scopes": scopes})
    return True


def restart(api: Api, name: str, say, **kw) -> dict:
    say("Restarting the app so the new permissions apply")
    api.call("POST", APPS + "/" + name + "/stop")

    def stopped():
        state = ((get_app(api, name) or {}).get("compute_status") or {}).get("state", "")
        return state in ("STOPPED", "ERROR")

    wait(stopped, 300, **kw)
    api.call("POST", APPS + "/" + name + "/start")
    return wait_active(api, name, say, **kw)


def deploy(api: Api, name: str, path: str, say, timeout: float = 900, **kw) -> dict:
    """Deploy the code in `path` and wait for the deployment to finish."""
    body = {"source_code_path": path, "mode": "SNAPSHOT"}
    for attempt in range(4):
        try:
            d = api.call("POST", APPS + "/" + name + "/deployments", json=body)
            break
        except DeployError as exc:
            # Seen live: right after a start Databricks can still say "not in
            # RUNNING state" for a little while.
            if "not in RUNNING state" not in str(exc) or attempt == 3:
                raise
            say("The app is not quite ready; trying the deployment again")
            wait_active(api, name, say, **kw)
    dep_id = d.get("deployment_id", "")
    say("Deploying %s" % version_of(path))

    def done():
        cur = api.call("GET", APPS + "/" + name + "/deployments/" + dep_id) if dep_id else d
        state = (cur.get("status") or {}).get("state", "")
        return cur if state in ("SUCCEEDED", "FAILED", "CANCELLED") else None

    cur = wait(done, timeout, **kw)
    if not cur:
        raise DeployError("The deployment did not finish within %d minutes." % (timeout // 60), 504)
    st = cur.get("status") or {}
    if st.get("state") != "SUCCEEDED":
        raise DeployError("Databricks could not start this version: %s" % (st.get("message") or st.get("state")), 502)
    return cur


# --- upload -----------------------------------------------------------------

def stage(repo: str, version: str, out: str, log_table: str, warehouse: str) -> str:
    """Write the release's files to `out`: the portal at `version` (from git),
    a VERSION file, and app.yaml set up for this client."""
    if not VERSION_RE.match(version):
        raise DeployError("Not a release version: %r" % version)
    if subprocess.run(["git", "rev-parse", "--verify", "--quiet", "refs/tags/" + version], cwd=repo,
                      capture_output=True).returncode != 0:
        raise DeployError("There is no release %s in the repository." % version, 404)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    tar = os.path.join(os.path.dirname(out), "release.tar")
    subprocess.run(["git", "archive", "--format=tar", "-o", tar, version], cwd=repo, check=True)
    subprocess.run(["tar", "-xf", tar, "-C", out], check=True)
    os.remove(tar)
    for name in os.listdir(out):
        if SHIP_EXCLUDE.match(name):
            p = os.path.join(out, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    with open(os.path.join(out, "VERSION"), "w", encoding="utf-8") as f:
        f.write(version + "\n")
    path = os.path.join(out, "app.yaml")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(client_yaml(text, log_table, warehouse))
    return out


def client_yaml(text: str, log_table: str, warehouse: str) -> str:
    """app.yaml with this client's env block. Only `env:` is replaced; the
    command and the rest stay as released."""
    lines = ["env:"]
    if log_table:
        lines += ["  - name: PORTAL_LOG_TABLE", "    value: " + log_table]
    if warehouse:
        lines += ["  - name: PORTAL_LOG_WAREHOUSE", "    value: " + warehouse]
    block = "\n".join(lines) + "\n" if len(lines) > 1 else "env: []\n"
    # The env block runs from "env:" to the next top-level key or comment.
    new, n = re.subn(r"(?m)^env:\n(?:[ \t]+.*\n|\n)*", block, text)
    return new if n else text.rstrip("\n") + "\n\n" + block


def upload(folder: str, path: str, say) -> None:
    """Copy the staged release into the workspace with the Databricks CLI (it
    signs in from DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET)."""
    say("Uploading the files")
    env = {k: v for k, v in os.environ.items() if k != "DATABRICKS_CONFIG_PROFILE"}
    out = subprocess.run(["databricks", "workspace", "import-dir", folder, path, "--overwrite"],
                         capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise DeployError("Uploading the files failed: " + (out.stderr or out.stdout)[-400:], 502)


# --- access -----------------------------------------------------------------

def sql(api: Api, warehouse: str, statement: str, **kw) -> None:
    r = api.call("POST", "/api/2.0/sql/statements", json={"warehouse_id": warehouse, "statement": statement,
                                                          "wait_timeout": "30s", "on_wait_timeout": "CONTINUE"})

    def done():
        cur = r if r.get("status", {}).get("state") not in ("PENDING", "RUNNING") else \
            api.call("GET", "/api/2.0/sql/statements/" + r["statement_id"])
        return cur if cur.get("status", {}).get("state") not in ("PENDING", "RUNNING") else None

    cur = wait(done, 300, every=3, **kw) or {}
    st = cur.get("status") or {}
    if st.get("state") != "SUCCEEDED":
        raise DeployError(((st.get("error") or {}).get("message") or st.get("state") or "timed out")[:300], 502)


def pick_warehouse(api: Api, wanted: str) -> str:
    if wanted:
        if not WAREHOUSE_RE.match(wanted):
            raise DeployError("WAREHOUSE_ID %r is not a warehouse id." % wanted)
        return wanted
    whs = api.call("GET", "/api/2.0/sql/warehouses").get("warehouses") or []
    whs.sort(key=lambda w: (w.get("state") != "RUNNING", not w.get("enable_serverless_compute"), w.get("name", "")))
    return whs[0]["id"] if whs else ""


def grant_access(api: Api, app: dict, log_table: str, warehouse: str, users_group: str, say) -> list[str]:
    """What the app's own identity needs, plus who may open the app. Each grant
    is tried on its own; a refusal becomes a warning, never a failed deploy (the
    portal runs without history, it just cannot save chats)."""
    warnings = []
    sp = app.get("service_principal_client_id") or ""
    name = app["name"]
    if users_group:
        if not GROUP_RE.match(users_group):
            warnings.append("Skipped opening the app to %r: not a valid group name." % users_group)
        else:
            try:
                api.call("PATCH", "/api/2.0/permissions/apps/" + name,
                         json={"access_control_list": [{"group_name": users_group, "permission_level": "CAN_USE"}]})
                say("Let the group %s open the portal" % users_group)
            except DeployError as exc:
                warnings.append("Could not let %s open the portal: %s" % (users_group, exc))
    if not sp:
        return warnings + ["Databricks did not say which identity the app runs as, so its data access was not set up."]
    if warehouse:
        try:
            api.call("PATCH", "/api/2.0/permissions/warehouses/" + warehouse,
                     json={"access_control_list": [{"service_principal_name": sp, "permission_level": "CAN_USE"}]})
        except DeployError as exc:
            warnings.append("Could not let the app use SQL warehouse %s: %s" % (warehouse, exc))
    if log_table:
        if not TABLE_RE.match(log_table):
            return warnings + ["PORTAL_LOG_TABLE %r is not catalog.schema.table; history stays off." % log_table]
        if not warehouse:
            return warnings + ["No SQL warehouse found, so chat history could not be set up."]
        cat, sch, _ = log_table.split(".")
        say("Setting up chat history in %s.%s" % (cat, sch))
        for stmt in ("CREATE SCHEMA IF NOT EXISTS `%s`.`%s`" % (cat, sch),
                     "GRANT USE CATALOG ON CATALOG `%s` TO `%s`" % (cat, sp),
                     "GRANT USE SCHEMA, CREATE TABLE, SELECT, MODIFY ON SCHEMA `%s`.`%s` TO `%s`" % (cat, sch, sp)):
            try:
                sql(api, warehouse, stmt)
            except DeployError as exc:
                warnings.append("%s failed: %s" % (stmt.split(" ON ")[0].split(" IF ")[0], exc))
    return warnings


# --- health -----------------------------------------------------------------

def check(api: Api, name: str, expect: str = "", http=httpx) -> dict:
    """How the app is doing: Databricks' view, then the portal's own view
    (`/api/health`, and errors from the admin endpoints when allowed).

    status: healthy | degraded | down | unverified
    """
    app = get_app(api, name)
    if app is None:
        return {"status": "down", "summary": "The app %s does not exist in this workspace." % name, "version": ""}
    app_state = (app.get("app_status") or {}).get("state", "")
    compute = (app.get("compute_status") or {}).get("state", "")
    active = app.get("active_deployment") or {}
    live = version_of(active.get("source_code_path", ""))
    out = {"url": app.get("url", ""), "app_state": app_state, "compute_state": compute, "version": live,
           "deployment_state": (active.get("status") or {}).get("state", "")}
    if compute != "ACTIVE" or app_state != "RUNNING":
        msg = (app.get("app_status") or {}).get("message") or (app.get("compute_status") or {}).get("message") or ""
        return {**out, "status": "down", "summary": "The app is %s%s." % ((app_state or compute or "unknown").lower(),
                                                                      (": " + msg) if msg else "")}
    if expect and live and live != expect:
        return {**out, "status": "degraded", "summary": "Running %s, expected %s." % (live, expect)}
    if not out["url"]:
        return {**out, "status": "unverified", "summary": "Running, but Databricks gave no address to check."}

    def get(path):
        return http.get(out["url"].rstrip("/") + path, headers={"Authorization": "Bearer " + api.token},
                        timeout=TIMEOUT, follow_redirects=False)

    try:
        r = get("/api/health")
    except Exception as exc:  # noqa: BLE001 - any network failure means "could not reach it"
        return {**out, "status": "down", "summary": "Could not reach the portal (%s)." % type(exc).__name__}
    if r.status_code in (301, 302, 303, 307, 401, 403):
        return {**out, "status": "unverified", "summary": "Running. The inside check was skipped: the app did not accept "
                                                          "the service principal's sign-in."}
    if r.status_code >= 500:
        return {**out, "status": "down", "summary": "The portal answered with an error (HTTP %d)." % r.status_code}
    try:
        h = r.json()
    except ValueError:
        h = {}
    if not h.get("ok"):
        return {**out, "status": "down", "summary": "The portal says it is not healthy."}
    served = h.get("version", "")
    if expect and served and served != expect:
        return {**out, "status": "degraded", "summary": "The portal serves %s, expected %s." % (served, expect)}
    out["version"] = served or live
    out.update(errors(get))
    rate = out.get("failure_rate", 0)
    if out.get("questions", 0) >= 3 and rate >= 0.25:
        return {**out, "status": "degraded", "summary": "Up, but %d%% of questions failed in the last day." % round(rate * 100)}
    return {**out, "status": "healthy", "summary": "Up and answering."}


def errors(get) -> dict:
    """Errors in the last day, from the portal's own Monitoring and log. Needs
    the service principal to count as a portal admin; skipped quietly if not."""
    out: dict = {}
    try:
        r = get("/api/admin/agent-health?days=1")
        if r.status_code == 200:
            h = r.json()
            out.update({"questions": h.get("questions", 0), "failed": h.get("failed", 0),
                        "failure_rate": round(h.get("failed", 0) / h["questions"], 4) if h.get("questions") else 0,
                        "error_kinds": [{"label": k.get("label"), "count": k.get("count")} for k in (h.get("kinds") or [])][:6],
                        "failing_assistants": [{"label": a.get("label"), "failure_rate": a.get("failure_rate"),
                                                "questions": a.get("questions")}
                                               for a in (h.get("agents") or []) if a.get("failed")][:5]})
        r = get("/api/admin/logs?days=1&limit=50")
        if r.status_code == 200:
            lines = r.json().get("lines") or []
            out["api_errors"] = len(lines)
            out["recent_errors"] = [{"at": x.get("at") or x.get("ts") or "", "message": str(x.get("message") or x.get("msg") or "")[:240]}
                                    for x in lines[:5]]
        if not out:
            out["errors_note"] = "Error counts need the service principal to be a portal admin (in the admins group)."
    except Exception as exc:  # noqa: BLE001 - the extras must never fail a check
        out["errors_note"] = "Could not read error counts (%s)." % type(exc).__name__
    return out


def scopes_from(repo: str) -> list[str]:
    """The user API scopes the portal needs, kept in the portal's own file."""
    with open(os.path.join(repo, "update-scopes.json"), encoding="utf-8") as f:
        return list(json.load(f)["user_api_scopes"])
