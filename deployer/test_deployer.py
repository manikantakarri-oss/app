"""Offline tests for the Portal Deployer. No workspace, no GitHub: every call
is faked. Run: python deployer/test_deployer.py
"""
from __future__ import annotations

import base64
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import clients  # noqa: E402
import common  # noqa: E402
import deploy  # noqa: E402
import ghub  # noqa: E402
import registry  # noqa: E402
import workspace as ws  # noqa: E402
from common import DeployError  # noqa: E402

CASES = []
common.time.sleep = lambda s: None  # every wait loop runs instantly


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


def raises(fn, *a, contains="", **kw):
    try:
        fn(*a, **kw)
    except DeployError as exc:
        assert contains.lower() in str(exc).lower(), str(exc)
        return exc
    raise AssertionError("expected DeployError")


class FakeApi:
    """A workspace: apps, deployments, permissions and SQL, with scripted failures."""

    def __init__(self, live: str = "", exists: bool = True, fail_deploy=None):
        self.host, self.token = "https://x", "TOKEN"
        self.calls = []
        self.app = None
        if exists:
            self.app = {"name": "agent-portal", "url": "https://agent-portal-1.apps", "service_principal_client_id": "sp-1",
                        "compute_status": {"state": "ACTIVE"}, "app_status": {"state": "RUNNING"},
                        "effective_user_api_scopes": ["a"],
                        "active_deployment": {"source_code_path": ws.release_path("cid", "agent-portal", live) if live else "",
                                              "status": {"state": "SUCCEEDED"}}}
        self.fail_deploy = fail_deploy or set()  # versions whose deployment fails
        self.fail = {}

    def call(self, method, path, *, json=None, params=None, quiet_404=False):
        self.calls.append((method, path, json))
        for (m, frag), exc in self.fail.items():
            if m == method and frag in path:
                raise exc
        if path == "/api/2.0/apps/agent-portal" and method == "GET":
            return self.app
        if path == "/api/2.0/apps" and method == "POST":
            self.app = {"name": json["name"], "url": "https://new.apps", "service_principal_client_id": "sp-2",
                        "compute_status": {"state": "ACTIVE"}, "app_status": {"state": "RUNNING"},
                        "effective_user_api_scopes": json["user_api_scopes"], "active_deployment": {}}
            return self.app
        if path.endswith("/deployments") and method == "POST":
            v = ws.version_of(json["source_code_path"])
            if v in self.fail_deploy:
                return {"deployment_id": "d-" + v, "status": {"state": "FAILED", "message": "boom in " + v}}
            self.app["active_deployment"] = {"source_code_path": json["source_code_path"], "status": {"state": "SUCCEEDED"}}
            return {"deployment_id": "d-" + v, "status": {"state": "SUCCEEDED"}}
        if "/deployments/" in path:
            v = path.rsplit("d-", 1)[-1]
            return {"status": {"state": "FAILED" if v in self.fail_deploy else "SUCCEEDED", "message": "boom in " + v}}
        if path == "/api/2.0/sql/warehouses":
            return {"warehouses": [{"id": "0123456789abcdef", "state": "RUNNING", "name": "w"}]}
        if path == "/api/2.0/sql/statements":
            return {"statement_id": "s1", "status": {"state": "SUCCEEDED"}}
        return {}

    def made(self, method, frag=""):
        return [c for c in self.calls if c[0] == method and frag in c[1]]


class FakeHttp:
    def __init__(self, routes):
        self.routes = routes  # path -> (status, json)

    def get(self, url, **kw):
        for path, (status, body) in self.routes.items():
            if url.endswith(path):
                return _Resp(status, body)
        return _Resp(404, {})


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._b = status, body

    def json(self):
        return self._b


def healthy_http(version):
    return FakeHttp({"/api/health": (200, {"ok": True, "version": version}),
                     "/api/admin/agent-health?days=1": (200, {"questions": 10, "failed": 1, "kinds": [], "agents": []}),
                     "/api/admin/logs?days=1&limit=50": (200, {"lines": [{"at": "t", "message": "x"}]})})


CFG = {"client": "client-acme", "version": "v1.1.0", "action": "deploy", "deploy_id": "11111111-1111-1111-1111-111111111111",
       "actor": "me@x.io", "run_url": "https://gh/run/1", "host": "https://x", "client_id": "cid", "secret": "s",
       "app": "agent-portal", "log_table": "main.portal.portal_logs", "warehouse": "", "users_group": "users"}


def run_deploy(api, cfg=None, http_for=None):
    """Run deploy.run with staging/upload/registry faked. Returns (code, rows, health_rows)."""
    rows, health_rows = [], []
    saved = (ws.stage, ws.upload, registry.safe, ws.check)
    ws.stage = lambda *a, **k: None
    ws.upload = lambda *a, **k: None
    registry.safe = lambda fn, *a, **k: health_rows.append(a) if fn is registry.record_health else None
    real_check = saved[3]
    ws.check = lambda api_, app, expect="", http=None: real_check(api_, app, expect,
                                                                  http=(http_for or healthy_http)(ws.version_of(api_.app["active_deployment"]["source_code_path"])))
    try:
        c = dict(cfg or CFG)
        rec = deploy.Recorder(c, write=lambda **kw: rows.append(kw))
        code = deploy.run(c, rec, api, ["a"], tempfile.gettempdir())
    finally:
        ws.stage, ws.upload, registry.safe, ws.check = saved
    return code, rows, health_rows


# --- inputs ------------------------------------------------------------------

@case("deploy inputs are validated before anything runs")
def _():
    env = {"CLIENT": "client-acme", "VERSION": "v1.2.3", "DEPLOY_ID": CFG["deploy_id"], "DATABRICKS_HOST": "h",
           "DATABRICKS_CLIENT_ID": "c", "DATABRICKS_CLIENT_SECRET": "s"}
    assert deploy.config(env)["app"] == "agent-portal"
    assert deploy.config({**env, "USERS_GROUP": "none"})["users_group"] == ""
    raises(deploy.config, {**env, "CLIENT": "acme; rm -rf /"}, contains="unknown client")
    raises(deploy.config, {**env, "VERSION": "main"}, contains="not a release")
    raises(deploy.config, {**env, "DEPLOY_ID": "x'"}, contains="deploy id")
    raises(deploy.config, {**env, "APP_NAME": "Bad_Name"}, contains="app_name")
    raises(deploy.config, {**env, "DATABRICKS_CLIENT_SECRET": ""}, contains="missing")


@case("the client form: names, addresses, ids and tables are checked; secrets required only when adding")
def _():
    good = {"slug": "acme", "name": "Acme", "host": "adb-1.2.azuredatabricks.net", "client_id": "8959a7fc-afea-4b8e-b7c4-5c3be8474df2",
            "secret": "s3cret", "log_table": "main.portal.portal_logs", "warehouse_id": "", "users_group": "users"}
    out = clients.clean(good, new=True)
    assert out["env"] == "client-acme" and out["DATABRICKS_HOST"] == "https://adb-1.2.azuredatabricks.net"
    assert out["APP_NAME"] == "agent-portal" and out[clients.SECRET] == "s3cret"
    raises(clients.clean, {**good, "slug": "Acme Corp"}, new=True, contains="short name")
    raises(clients.clean, {**good, "host": "https://evil.com/path?x"}, new=True, contains="address")
    raises(clients.clean, {**good, "client_id": "nope"}, new=True, contains="application id")
    raises(clients.clean, {**good, "log_table": "main.portal"}, new=True, contains="catalog.schema.table")
    raises(clients.clean, {**good, "warehouse_id": "abc"}, new=True, contains="warehouse")
    raises(clients.clean, {**good, "secret": ""}, new=True, contains="secret")
    assert clients.SECRET not in clients.clean({"name": "Acme 2"}, new=False)


# --- staging -----------------------------------------------------------------

@case("app.yaml: only the env block changes, per client")
def _():
    text = "command:\n  - uvicorn\n\n# comment\nenv:\n  - name: PORTAL_LOG_TABLE\n    value: old.a.b\n\nuser_api_scopes:\n  - x\n"
    out = ws.client_yaml(text, "main.p.portal_logs", "0123456789abcdef")
    assert "old.a.b" not in out and "value: main.p.portal_logs" in out and "PORTAL_LOG_WAREHOUSE" in out
    assert out.startswith("command:\n  - uvicorn") and "user_api_scopes:\n  - x" in out
    assert "env: []" in ws.client_yaml(text, "", "")


@case("a release is staged from its git tag: portal files only, plus VERSION and the client's app.yaml")
def _():
    with tempfile.TemporaryDirectory() as d:
        repo = os.path.join(d, "repo")
        os.makedirs(os.path.join(repo, "web"))
        os.makedirs(os.path.join(repo, "deployer"))
        files = {"app.py": "x", "app.yaml": "command: [a]\nenv:\n  - name: X\n    value: y\n", "test_app.py": "t",
                 "web/index.html": "<html>", "deployer/app.py": "secret stuff", "README.md": "r"}
        for p, body in files.items():
            with open(os.path.join(repo, p), "w") as f:
                f.write(body)
        git = lambda *a: subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=repo, check=True,
                                        capture_output=True)
        git("init", "-q")
        git("add", "-A")
        git("commit", "-qm", "r")
        git("tag", "v1.0.0")
        out = ws.stage(repo, "v1.0.0", os.path.join(d, "out"), "main.p.portal_logs", "")
        got = sorted(os.path.relpath(os.path.join(r, f), out).replace("\\", "/") for r, _, fs in os.walk(out) for f in fs)
        assert got == ["VERSION", "app.py", "app.yaml", "web/index.html"], got
        assert open(os.path.join(out, "VERSION")).read().strip() == "v1.0.0"
        assert "main.p.portal_logs" in open(os.path.join(out, "app.yaml")).read()
        raises(ws.stage, repo, "v9.9.9", os.path.join(d, "out2"), "", "", contains="no release")


# --- health ------------------------------------------------------------------

@case("health: healthy, wrong version, down, unreachable, and sign-in refused are told apart")
def _():
    api = FakeApi(live="v1.0.0")
    h = ws.check(api, "agent-portal", "v1.0.0", http=healthy_http("v1.0.0"))
    assert h["status"] == "healthy" and h["questions"] == 10 and h["api_errors"] == 1, h
    assert ws.check(api, "agent-portal", "v2.0.0", http=healthy_http("v1.0.0"))["status"] == "degraded"
    assert ws.check(api, "agent-portal", "", http=FakeHttp({"/api/health": (302, {})}))["status"] == "unverified"
    assert ws.check(api, "agent-portal", "", http=FakeHttp({"/api/health": (502, {})}))["status"] == "down"
    api.app["app_status"] = {"state": "CRASHED", "message": "exit 1"}
    h = ws.check(api, "agent-portal", "", http=healthy_http("v1.0.0"))
    assert h["status"] == "down" and "exit 1" in h["summary"]
    assert ws.check(FakeApi(exists=False), "agent-portal")["status"] == "down"


@case("health: a high failure rate is degraded; missing admin rights only skip the error counts")
def _():
    api = FakeApi(live="v1.0.0")
    bad = FakeHttp({"/api/health": (200, {"ok": True, "version": "v1.0.0"}),
                    "/api/admin/agent-health?days=1": (200, {"questions": 8, "failed": 4, "kinds": [{"label": "Timeout", "count": 4}],
                                                            "agents": [{"label": "A", "failed": 4, "questions": 8, "failure_rate": 0.5}]})})
    h = ws.check(api, "agent-portal", "", http=bad)
    assert h["status"] == "degraded" and h["failing_assistants"][0]["label"] == "A"
    no_admin = FakeHttp({"/api/health": (200, {"ok": True}), "/api/admin/agent-health?days=1": (403, {}),
                         "/api/admin/logs?days=1&limit=50": (403, {})})
    h = ws.check(api, "agent-portal", "", http=no_admin)
    assert h["status"] == "healthy" and "admin" in h["errors_note"]


# --- deploy ------------------------------------------------------------------

@case("a deploy records each step and ends live on the new version, with a health record")
def _():
    api = FakeApi(live="v1.0.0")
    code, rows, health = run_deploy(api)
    assert code == 0, rows[-1]
    assert rows[-1]["status"] == "succeeded" and rows[-1]["step"].startswith("Live on v1.1.0")
    assert all(r["from_version"] in ("", "v1.0.0") for r in rows) and rows[-1]["from_version"] == "v1.0.0"
    assert ws.version_of(api.app["active_deployment"]["source_code_path"]) == "v1.1.0"
    assert len(health) == 1
    # access was set up: users group on the app, warehouse for the app's identity, three SQL statements
    assert api.made("PATCH", "/permissions/apps/agent-portal") and api.made("PATCH", "/permissions/warehouses/")
    assert len(api.made("POST", "/sql/statements")) == 3
    # scopes changed (["a"] -> ["a"] is unchanged): no restart
    assert not api.made("POST", "/stop")


@case("a failed deploy puts the previous version back automatically and records both")
def _():
    api = FakeApi(live="v1.0.0", fail_deploy={"v1.1.0"})
    code, rows, health = run_deploy(api)
    assert code == 1
    assert ws.version_of(api.app["active_deployment"]["source_code_path"]) == "v1.0.0"
    final = rows[-1]
    assert final["status"] == "rolled_back" and "boom in v1.1.0" in final["message"], final
    back = [r for r in rows if r["action"] == "auto_rollback"]
    assert back and back[-1]["status"] == "succeeded" and back[-1]["version"] == "v1.0.0"
    assert back[-1]["deploy_id"] != CFG["deploy_id"]  # its own record, so "current version" reads v1.0.0
    assert len(health) == 1


@case("no automatic rollback on a first install, or when nothing live had changed yet")
def _():
    code, rows, _ = run_deploy(FakeApi(exists=False, fail_deploy={"v1.1.0"}))
    assert code == 1 and rows[-1]["status"] == "failed" and not [r for r in rows if r["action"] == "auto_rollback"]
    api = FakeApi(live="v1.0.0")
    saved, saved_up = ws.stage, ws.upload
    try:
        def broken(*a, **k):
            raise DeployError("There is no release v1.1.0 in the repository.", 404)
        ws.upload = lambda *a, **k: None
        rows2 = []
        ws.stage = broken
        rec = deploy.Recorder(dict(CFG), write=lambda **kw: rows2.append(kw))
        code = deploy.run(dict(CFG), rec, api, ["a"], tempfile.gettempdir())
    finally:
        ws.stage, ws.upload = saved, saved_up
    assert code == 1 and rows2[-1]["status"] == "failed" and not api.made("POST", "/deployments")


@case("if putting the old version back also fails, the record says so plainly")
def _():
    code, rows, _ = run_deploy(FakeApi(live="v1.0.0", fail_deploy={"v1.1.0", "v1.0.0"}))
    assert code == 1 and rows[-1]["status"] == "failed" and "also failed" in rows[-1]["step"], rows[-1]


@case("access refusals are warnings, not failures; scopes are only written when they changed")
def _():
    api = FakeApi(live="v1.0.0")
    api.fail[("PATCH", "/permissions/warehouses/")] = DeployError("no", 403)
    saved = ws.sql

    def no_sql(*a, **k):
        raise DeployError("PERMISSION_DENIED", 403)
    ws.sql = no_sql
    try:
        code, rows, _ = run_deploy(api, cfg=CFG)
    finally:
        ws.sql = saved
    assert code == 0 and "warning" in rows[-1]["step"], rows[-1]["step"]
    assert len(rows[-1]["detail"]["warnings"]) == 4  # warehouse + 3 statements
    api2 = FakeApi(live="v1.0.0")
    changed = ws.set_scopes(api2, "agent-portal", api2.app, ["a", "b"], lambda s: None)
    assert changed and api2.made("PATCH", "/api/2.0/apps/agent-portal")
    assert not ws.set_scopes(api2, "agent-portal", api2.app, ["a"], lambda s: None)


@case("a new app is created with the portal's scopes, and its compute is started if stopped")
def _():
    api = FakeApi(exists=False)
    app, created = ws.ensure_app(api, "agent-portal", ["x"], lambda s: None)
    assert created and api.made("POST", "/api/2.0/apps")[0][2]["user_api_scopes"] == ["x"]
    api = FakeApi(live="v1.0.0")
    states = iter(["STOPPED", "STARTING", "ACTIVE"])
    orig = api.call

    def call(method, path, **kw):
        if method == "GET" and path == "/api/2.0/apps/agent-portal":
            api.app["compute_status"] = {"state": next(states, "ACTIVE")}
        return orig(method, path, **kw)
    api.call = call
    ws.wait_active(api, "agent-portal", lambda s: None)
    assert api.made("POST", "/start")
    raises(ws.ensure_app, FakeApi(), "Bad_Name", [], lambda s: None, contains="not allowed")


# --- GitHub --------------------------------------------------------------------

@case("secrets are sealed with the environment's public key (only the private key opens them)")
def _():
    from nacl.public import PrivateKey, SealedBox

    k = PrivateKey.generate()
    sealed = ghub.seal(base64.b64encode(bytes(k.public_key)).decode(), "top secret")
    assert "top secret" not in sealed
    assert SealedBox(k).decrypt(base64.b64decode(sealed)) == b"top secret"


@case("environment variables: new ones created, changed ones updated, emptied ones deleted, same ones untouched")
def _():
    calls = []
    saved = ghub.call
    ghub.call = lambda method, path, **kw: calls.append((method, path.rsplit("/", 1)[-1], kw.get("json")))
    try:
        ghub.set_vars("client-acme", {"A": "1", "B": "2", "C": "", "D": "same"}, have={"B": "old", "C": "x", "D": "same"})
    finally:
        ghub.call = saved
    assert ("POST", "variables", {"name": "A", "value": "1"}) in calls
    assert ("PATCH", "B", {"name": "B", "value": "2"}) in calls
    assert ("DELETE", "C", None) in calls
    assert len(calls) == 3
    raises(ghub.set_vars, "acme", {"A": "1"}, have={}, contains="unknown client")


# --- the deployer's decisions --------------------------------------------------

class World:
    """GitHub + registry for clients.py, in memory."""

    def __init__(self, deploys=None, releases=("v1.0.0", "v1.1.0")):
        self.deploys = list(deploys or [])
        self.rows = []
        self.dispatched = []
        self.saved = {}
        self.releases = [{"version": v} for v in releases]
        self.run = None

    def __enter__(self):
        fakes = {
            (ghub, "clients"): lambda: ["client-acme"],
            (ghub, "variables"): lambda env: {"DATABRICKS_HOST": "https://x", "DATABRICKS_CLIENT_ID": "c"},
            (ghub, "secret_set"): lambda env, name: "2026-10-01",
            (ghub, "releases"): lambda: self.releases,
            (ghub, "dispatch"): lambda wf, inputs: self.dispatched.append((wf, inputs)),
            (ghub, "find_run"): lambda wf, marker: self.run,
            (registry, "latest_deploys"): lambda client="", limit=200: self.deploys,
            (registry, "record"): lambda *a, **kw: self.rows.append((a, kw)),
            (registry, "safe"): lambda fn, *a, **kw: self.rows.append((a, kw)),
            (registry, "steps"): lambda deploy_id: [dict(r) for r in self.deploys if r["deploy_id"] == deploy_id],
            (registry, "last_good"): lambda client, other_than="": next(
                (d["version"] for d in self.deploys if d["status"] == "succeeded" and d["version"] != other_than), ""),
        }
        for (mod, name), fn in fakes.items():
            self.saved[(mod, name)] = getattr(mod, name)
            setattr(mod, name, fn)
        return self

    def __exit__(self, *a):
        for (mod, name), fn in self.saved.items():
            setattr(mod, name, fn)


def row(version, status, deploy_id="d1", at="2026-10-06T10:00:00Z", action="deploy"):
    return {"deploy_id": deploy_id, "client": "client-acme", "version": version, "status": status, "at": at,
            "started": at, "action": action, "from_version": "", "actor": "a", "run_url": ""}


@case("deploy requests are recorded before GitHub is asked, by the signed-in person")
def _():
    with World([row("v1.0.0", "succeeded")]) as w:
        out = clients.start("client-acme", "v1.1.0", "deploy", "me@x.io")
    (args, kw), = w.rows
    assert kw["status"] == "requested" and kw["actor"] == "me@x.io" and kw["from_version"] == "v1.0.0"
    wf, inputs = w.dispatched[0]
    assert wf == "deploy.yml" and inputs["deploy_id"] == out["deploy_id"] and inputs["version"] == "v1.1.0"


@case("deploy refuses unknown versions, a second deploy in flight, and incomplete clients")
def _():
    with World() as w:
        raises(clients.start, "client-acme", "v9.0.0", "deploy", "me", contains="not a published release")
        raises(clients.start, "client-zzz", "v1.0.0", "deploy", "me", contains="no client")
        assert not w.dispatched
    now = clients._now().isoformat()
    with World([row("v1.1.0", "running", at=now)]) as w:
        raises(clients.start, "client-acme", "v1.0.0", "deploy", "me", contains="already being deployed")
    with World() as w:
        ghub.secret_set = lambda env, name: ""
        raises(clients.start, "client-acme", "v1.0.0", "deploy", "me", contains="incomplete")


@case("rollback with no version picks the last good one before the current version")
def _():
    deploys = [row("v1.1.0", "succeeded", "d2", "2026-10-06T11:00:00Z"), row("v1.0.0", "succeeded", "d1")]
    with World(deploys) as w:
        out = clients.start("client-acme", "", "rollback", "me")
    assert out["version"] == "v1.0.0" and w.dispatched[0][1]["action"] == "rollback"
    with World([row("v1.0.0", "succeeded")]) as w:
        raises(clients.start, "client-acme", "", "rollback", "me", contains="no earlier version")


@case("a GitHub job that ended (or never started) without finishing its record is recorded as failed")
def _():
    with World([row("v1.1.0", "running")]) as w:
        w.run = {"status": "completed", "conclusion": "cancelled", "url": "u"}
        w.deploys[0]["deploy_id"] = CFG["deploy_id"]
        clients.status(CFG["deploy_id"])
        (_, kw), = w.rows
        assert kw["status"] == "failed" and "cancelled" in kw["message"]
    with World([row("v1.1.0", "requested", at="2020-01-01T00:00:00Z")]) as w:
        w.deploys[0]["deploy_id"] = CFG["deploy_id"]
        clients.status(CFG["deploy_id"])
        assert "did not start" in w.rows[0][1]["message"]
    with World([row("v1.1.0", "running", at=clients._now().isoformat())]) as w:
        w.deploys[0]["deploy_id"] = CFG["deploy_id"]
        clients.status(CFG["deploy_id"])
        assert not w.rows  # still within the grace period and no run yet: leave it


@case("the app: only the deployer group gets in, and the actor comes from the token")
def _():
    from fastapi.testclient import TestClient

    import app as deployer_app

    saved = deployer_app.me
    deployer_app.me = lambda tok: {"user_name": "real@x.io", "display_name": "R", "allowed": tok == "ADMIN", "group": "admins"}
    seen = []
    saved_start = clients.start
    clients.start = lambda env, version, action, actor: seen.append(actor) or {"deploy_id": "x", "version": version}
    try:
        c = TestClient(deployer_app.app)
        r = c.post("/api/clients/client-acme/deploy", json={"version": "v1.0.0", "actor": "spoof@x.io"},
                   headers={"X-Forwarded-Access-Token": "NOPE"})
        assert r.status_code == 403 and "admins" in r.json()["detail"]
        r = c.post("/api/clients/client-acme/deploy", json={"version": "v1.0.0", "actor": "spoof@x.io"},
                   headers={"X-Forwarded-Access-Token": "ADMIN"})
        assert r.status_code == 200 and seen == ["real@x.io"]
    finally:
        deployer_app.me = saved
        clients.start = saved_start


def main() -> int:
    passed = failed = 0
    for name, fn in CASES:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - test harness
            print("  FAIL  " + name)
            print("        %s: %s" % (type(exc).__name__, str(exc)[:300]))
            failed += 1
        else:
            print("  PASS  " + name)
            passed += 1
    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
