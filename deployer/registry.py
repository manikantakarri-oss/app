"""The deployment record: which version went to which client, when, by whom,
how it went, and every health check since. Two append-only Delta tables in our
own workspace, in REGISTRY_SCHEMA (default `databrickspoc.portal_deployer`):

  deployments  one row per step of a deploy/rollback; the newest row of a
               `deploy_id` is its current state. Statuses: requested, running,
               succeeded, failed, rolled_back.
  health       one row per health check.

Append-only on purpose: the deployer app (who asked) and GitHub Actions (who
did it) write to the same deploy at different times, and appends never clash.
Every value is a bound parameter; the schema name is validated.

The secret side lives elsewhere (GitHub Environments) and is never written here.
"""
from __future__ import annotations

import json
import os

import httpx

import home
from common import SCHEMA_RE, WAREHOUSE_RE, Api, DeployError, wait

FINAL = ("succeeded", "failed", "rolled_back")
_ready: set = set()
_ready_cache: dict = {}


def schema() -> str:
    s = os.environ.get("REGISTRY_SCHEMA") or "databrickspoc.portal_deployer"
    if not SCHEMA_RE.match(s):
        raise DeployError("REGISTRY_SCHEMA must be catalog.schema, got %r" % s, 500)
    return s


def _api() -> Api:
    return Api(home.home_host(), home.app_token())


def _warehouse(api: Api) -> str:
    w = os.environ.get("HOME_WAREHOUSE_ID") or os.environ.get("REGISTRY_WAREHOUSE") or ""
    if w:
        if not WAREHOUSE_RE.match(w):
            raise DeployError("The registry warehouse id %r is not valid." % w, 500)
        return w
    if "wh" not in _ready_cache:
        whs = api.call("GET", "/api/2.0/sql/warehouses").get("warehouses") or []
        whs.sort(key=lambda x: (x.get("state") != "RUNNING", not x.get("enable_serverless_compute"), x.get("name", "")))
        if not whs:
            raise DeployError("No SQL warehouse is available for the deployment record.", 503)
        _ready_cache["wh"] = whs[0]["id"]
    return _ready_cache["wh"]


def run(statement: str, params: dict | None = None, api: Api | None = None) -> list[dict]:
    """Run one statement; rows come back as dicts."""
    api = api or _api()
    body = {"warehouse_id": _warehouse(api), "statement": statement, "wait_timeout": "30s",
            "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE",
            "parameters": [{"name": k, "value": None if v is None else str(v), "type": "STRING"}
                           for k, v in (params or {}).items()]}
    r = api.call("POST", "/api/2.0/sql/statements", json=body)

    def done():
        cur = r if (r.get("status") or {}).get("state") not in ("PENDING", "RUNNING") else \
            api.call("GET", "/api/2.0/sql/statements/" + r["statement_id"])
        return cur if (cur.get("status") or {}).get("state") not in ("PENDING", "RUNNING") else None

    cur = wait(done, 120, every=2) or {}
    st = cur.get("status") or {}
    if st.get("state") != "SUCCEEDED":
        raise DeployError("Deployment record: " + ((st.get("error") or {}).get("message") or st.get("state") or "timed out")[:300], 502)
    cols = [c["name"] for c in ((cur.get("manifest") or {}).get("schema") or {}).get("columns") or []]
    return [dict(zip(cols, row)) for row in ((cur.get("result") or {}).get("data_array") or [])]


def ensure() -> None:
    """Create the schema and tables once per process. On Azure, CREATE ... IF
    NOT EXISTS is refused without CREATE privileges even when the object exists
    (seen with the portal's own tables), so a refusal falls back to reading."""
    s = schema()
    if s in _ready:
        return
    # Usually the tables exist: one cheap query instead of three statements.
    try:
        run("SELECT 1 FROM %s.deployments CROSS JOIN %s.health LIMIT 0" % (s, s))
        _ready.add(s)
        return
    except DeployError:
        pass
    cat, sch = s.split(".")
    stmts = [
        "CREATE SCHEMA IF NOT EXISTS `%s`.`%s`" % (cat, sch),
        "CREATE TABLE IF NOT EXISTS %s.deployments (deploy_id STRING, client STRING, action STRING, version STRING, "
        "from_version STRING, status STRING, step STRING, message STRING, actor STRING, run_url STRING, detail STRING, "
        "at TIMESTAMP)" % s,
        "CREATE TABLE IF NOT EXISTS %s.health (check_id STRING, client STRING, version STRING, status STRING, "
        "summary STRING, detail STRING, actor STRING, run_url STRING, at TIMESTAMP)" % s,
    ]
    for st in stmts:
        try:
            run(st)
        except DeployError:
            if "SCHEMA" in st:
                continue
            table = st.split("EXISTS ")[1].split(" ")[0]
            try:
                run("SELECT 1 FROM %s LIMIT 1" % table)
            except DeployError as exc:
                raise DeployError("The deployment record table %s cannot be created or read. Grant the deployer USE "
                                  "CATALOG on %s and USE SCHEMA, CREATE TABLE, SELECT, MODIFY on %s. (%s)"
                                  % (table, cat, s, exc), 503) from exc
    _ready.add(s)


def record(deploy_id: str, client: str, *, action: str, version: str, status: str, step: str = "", message: str = "",
           from_version: str = "", actor: str = "", run_url: str = "", detail: dict | None = None) -> None:
    ensure()
    run("INSERT INTO %s.deployments VALUES (:deploy_id, :client, :action, :version, :from_version, :status, :step, "
        ":message, :actor, :run_url, :detail, current_timestamp())" % schema(),
        {"deploy_id": deploy_id, "client": client, "action": action, "version": version, "from_version": from_version,
         "status": status, "step": step, "message": message[:2000], "actor": actor, "run_url": run_url,
         "detail": json.dumps(detail or {})[:20000]})


def record_health(check_id: str, client: str, result: dict, actor: str = "", run_url: str = "") -> None:
    ensure()
    run("INSERT INTO %s.health VALUES (:check_id, :client, :version, :status, :summary, :detail, :actor, :run_url, "
        "current_timestamp())" % schema(),
        {"check_id": check_id, "client": client, "version": result.get("version", ""), "status": result.get("status", ""),
         "summary": result.get("summary", "")[:1000], "detail": json.dumps(result)[:20000], "actor": actor,
         "run_url": run_url})


def _rows(rows: list[dict]) -> list[dict]:
    for r in rows:
        try:
            r["detail"] = json.loads(r.get("detail") or "{}")
        except ValueError:
            r["detail"] = {}
    return rows


def latest_deploys(client: str = "", limit: int = 200) -> list[dict]:
    """Each deploy's current state (newest row per deploy_id), newest first."""
    ensure()
    where = "WHERE client = :client" if client else ""
    rows = run("SELECT d.*, f.at AS started FROM (SELECT * FROM %s.deployments %s QUALIFY ROW_NUMBER() OVER "
               "(PARTITION BY deploy_id ORDER BY at DESC) = 1) d JOIN (SELECT deploy_id, min(at) AS at FROM %s.deployments "
               "GROUP BY deploy_id) f USING (deploy_id) ORDER BY f.at DESC LIMIT %d"
               % (schema(), where, schema(), max(1, min(500, int(limit)))), {"client": client} if client else None)
    return _rows(rows)


def steps(deploy_id: str) -> list[dict]:
    ensure()
    return _rows(run("SELECT * FROM %s.deployments WHERE deploy_id = :id ORDER BY at" % schema(), {"id": deploy_id}))


def latest_health(client: str = "", limit: int = 100) -> list[dict]:
    ensure()
    if client:
        return _rows(run("SELECT * FROM %s.health WHERE client = :client ORDER BY at DESC LIMIT %d"
                         % (schema(), max(1, min(500, int(limit)))), {"client": client}))
    return _rows(run("SELECT * FROM %s.health QUALIFY ROW_NUMBER() OVER (PARTITION BY client ORDER BY at DESC) = 1"
                     % schema()))


def current_versions() -> dict:
    """client -> the version of its newest successful deploy or rollback."""
    out: dict = {}
    for d in latest_deploys(limit=500):  # newest first
        if d["status"] == "succeeded" and d["client"] not in out:
            out[d["client"]] = d["version"]
    return out


def last_good(client: str, other_than: str = "") -> str:
    """The newest version that deployed successfully for this client, other
    than `other_than`; '' if none."""
    for d in latest_deploys(client, 200):
        if d["status"] == "succeeded" and d["version"] and d["version"] != other_than:
            return d["version"]
    return ""


def safe(fn, *a, **kw):
    """Call a registry write without letting a registry problem fail a deploy.
    Prints the problem (it shows in the GitHub Actions log) and returns None."""
    try:
        return fn(*a, **kw)
    except (DeployError, httpx.HTTPError, KeyError) as exc:
        print("::warning::Could not write the deployment record: %s" % exc)
        return None
