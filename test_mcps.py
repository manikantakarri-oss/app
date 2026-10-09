"""MCP catalog tests - a fake GitHub archive and a fake Databricks, no network.

Run: python test_mcps.py
"""
from __future__ import annotations

import io
import os
import tarfile
import time

import builder
import mcps
from dbx import DbxError

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


CARD = """
name: Report builder
description: >
  Builds a report
  from a workbook.
version: 0.1.0
tools:
  - name: make_report
    description: Builds it.
    changes_data: true
  - description: no name, dropped
needs:
  secrets: []
  volumes: [read, write]
"""


def archive(files: dict) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for path, data in files.items():
            raw = data.encode() if isinstance(data, str) else data
            info = tarfile.TarInfo("mcps-main/" + path)
            info.size = len(raw)
            tf.addfile(info, io.BytesIO(raw))
    return buf.getvalue()


REPO = {
    "README.md": "top level, ignored",
    "_template/mcp.yaml": "name: t",
    "_template/app.yaml": "command: []",
    "good/mcp.yaml": CARD,
    "good/app.yaml": "command: ['python', 'server.py']",
    "good/server.py": "print('hi')",
    "good/data/x.bin": b"\x00\x01\x02",
    "good/__pycache__/server.cpython-312.pyc": b"junk",
    "good/tests/test_x.py": "skipped",
    "no-app/mcp.yaml": "name: No app",
    "Bad_Name/mcp.yaml": "name: Bad",
    "Bad_Name/app.yaml": "command: []",
    "custom/mcp.yaml": "name: Custom\napp_name: my-existing-app",
    "custom/app.yaml": "command: []",
    "broken/mcp.yaml": "name: [unclosed",
}


@case("a release's shipped catalog is the catalog: only its MCPs are listed and installed, binaries intact, no GitHub")
def _():
    import json
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        for slug in ("report", "weather"):
            os.makedirs(os.path.join(d, slug, "data"))
            with open(os.path.join(d, slug, "mcp.yaml"), "w") as f:
                f.write("name: %s\n" % slug.title())
            with open(os.path.join(d, slug, "app.yaml"), "w") as f:
                f.write("command: [python, server.py]\n")
        with open(os.path.join(d, "report", "data", "t.pptx"), "wb") as f:
            f.write(bytes(range(256)))
        with open(os.path.join(d, "CATALOG.json"), "w") as f:
            json.dump({"ref": "v1.0.0", "sha": "a" * 40, "mcps": ["report", "weather"]}, f)
        saved_local, saved_cache = mcps.LOCAL, mcps._cache
        saved_http = mcps.http
        mcps.http = lambda: (_ for _ in ()).throw(AssertionError("GitHub must not be read"))
        mcps.LOCAL, mcps._cache = d, None
        try:
            entries, _note = mcps.catalog(refresh=True)
            assert [e["slug"] for e in entries] == ["report", "weather"]
            files = dict((rel, data) for rel, data in mcps._files(mcps._archive(), "report"))
            assert files.get("data/t.pptx") == bytes(range(256)) and "mcp.yaml" in files, sorted(files)
            assert mcps.shipped()["ref"] == "v1.0.0"
            # a folder the manifest does not list (left from an earlier upload) is not offered
            with open(os.path.join(d, "CATALOG.json"), "w") as f:
                json.dump({"ref": "v1.0.0", "mcps": ["weather"]}, f)
            mcps._cache = None
            assert [e["slug"] for e in mcps.catalog(refresh=True)[0]] == ["weather"]
        finally:
            mcps.LOCAL, mcps._cache, mcps.http = saved_local, saved_cache, saved_http


@case("catalog lists folders with an mcp.yaml, skips the template and unreadable cards")
def _():
    slugs = [e["slug"] for e in mcps.parse_catalog(archive(REPO))]
    assert slugs == ["Bad_Name", "custom", "good", "no-app"], slugs


@case("a card is read into plain fields; tools without a name are dropped")
def _():
    e = {e["slug"]: e for e in mcps.parse_catalog(archive(REPO))}["good"]
    assert e["name"] == "Report builder"
    assert e["description"] == "Builds a report from a workbook."
    assert e["app_name"] == "mcp-good" and e["problem"] == ""
    assert [t["name"] for t in e["tools"]] == ["make_report"] and e["tools"][0]["changes_data"] is True
    assert e["needs"]["volumes"] == ["read", "write"]


@case("app name is mcp-<folder> unless the card names an existing app")
def _():
    by = {e["slug"]: e for e in mcps.parse_catalog(archive(REPO))}
    assert by["custom"]["app_name"] == "my-existing-app"


@case("folders that cannot deploy are listed with the reason")
def _():
    by = {e["slug"]: e for e in mcps.parse_catalog(archive(REPO))}
    assert "app.yaml" in by["no-app"]["problem"]
    assert "lowercase" in by["Bad_Name"]["problem"]


@case("two folders cannot claim the same app")
def _():
    repo = dict(REPO)
    repo["aaa/mcp.yaml"] = "name: A\napp_name: mcp-good"
    repo["aaa/app.yaml"] = "command: []"
    by = {e["slug"]: e for e in mcps.parse_catalog(archive(repo))}
    assert by["good"]["problem"] and "aaa" in by["good"]["problem"]


@case("deploy copies only the folder, without caches or tests")
def _():
    got = dict(mcps._files(archive(REPO), "good"))
    assert set(got) == {"mcp.yaml", "app.yaml", "server.py", "data/x.bin"}, set(got)
    assert got["data/x.bin"] == b"\x00\x01\x02"


@case("a folder without app.yaml refuses to deploy")
def _():
    try:
        mcps._files(archive(REPO), "no-app")
    except DbxError as exc:
        assert exc.status == 400
    else:
        raise AssertionError("deployed without app.yaml")


@case("an oversized file is refused with its name")
def _():
    big = dict(REPO)
    big["good/big.bin"] = b"0" * (mcps.MAX_FILE + 1)
    try:
        mcps._files(archive(big), "good")
    except DbxError as exc:
        assert "big.bin" in str(exc)
    else:
        raise AssertionError("accepted an oversized file")


APP = {"name": "mcp-good", "url": "https://x", "service_principal_client_id": "sp-1", "active_deployment": {"deployment_id": "1"},
       "app_status": {"state": "RUNNING"}, "compute_status": {"state": "ACTIVE"}}


@case("state: no app is not deployed; a running app is running")
def _():
    assert mcps._state(None, None)[0] == "not_deployed"
    assert mcps._state(APP, None)[0] == "running"


@case("state: stopped, deploying and failed come from Databricks")
def _():
    assert mcps._state({**APP, "compute_status": {"state": "STOPPED"}}, None)[0] == "stopped"
    busy = {**APP, "app_status": {"state": "DEPLOYING"}, "pending_deployment": {"status": {"state": "IN_PROGRESS"}}}
    assert mcps._state(busy, None)[0] == "deploying"
    assert mcps._state({**APP, "app_status": {"state": "CRASHED", "message": "boom"}}, None) == ("failed", "boom")


@case("state: our own copy-in-progress shows as deploying even before Databricks knows")
def _():
    prog = {"phase": "copying", "message": "Copying the files.", "at": time.time()}
    assert mcps._state(None, prog)[0] == "deploying"
    assert mcps._state({"name": "x"}, prog)[0] == "deploying"


@case("state: a running app is ready even if a stale or newer deployment is pending")
def _():
    stale = {**APP, "pending_deployment": {"status": {"state": "IN_PROGRESS"}}}
    assert mcps._state(stale, None)[0] == "running"


@case("state: active compute and a deployment, with a status we do not recognise, counts as ready")
def _():
    odd = {**APP, "app_status": {"state": "SOMETHING_NEW"}}
    assert mcps._state(odd, None)[0] == "running"
    assert mcps._state({**odd, "compute_status": {"state": "WEIRD"}}, None)[0] == "deploying"


@case("state: a submitted deploy does not keep a running app 'deploying'")
def _():
    prog = {"phase": "submitted", "message": "Deploying.", "at": time.time()}
    assert mcps._state(APP, prog)[0] == "running"
    assert mcps._state({"name": "x"}, prog)[0] == "deploying"  # Databricks has not shown it yet


@case("state: a failed deployment is reported with Databricks' message")
def _():
    app = {**APP, "app_status": {"state": "UNAVAILABLE"},
           "pending_deployment": {"status": {"state": "FAILED", "message": "bad requirements"}}}
    assert mcps._state(app, None) == ("failed", "bad requirements")


@case("state: a failed deploy shows its reason until the app has a good deployment")
def _():
    prog = {"phase": "failed", "message": "nope", "at": time.time()}
    assert mcps._state(None, prog) == ("failed", "nope")
    assert mcps._state(APP, prog)[0] == "running"


class Fake:
    def __init__(self, apps=None):
        self.calls = []
        self.apps = apps if apps is not None else {}
        self.hidden = set()  # listed, but a direct lookup says 404 (just deleted)
        self.fail = {}

    def __call__(self, method, path, token, **kw):
        self.calls.append((method, path, token, kw.get("json")))
        for (m, frag), exc in self.fail.items():
            if m == method and frag in path:
                raise exc
        if method == "GET" and path == "/api/2.0/apps":
            return {"apps": list(self.apps.values())}
        if method == "GET" and path.startswith("/api/2.0/apps/"):
            name = path.rsplit("/", 1)[-1]
            if name in self.apps and name not in self.hidden:
                return self.apps[name]
            raise DbxError("not found", 404)
        if method == "POST" and path == "/api/2.0/apps":
            self.apps[kw["json"]["name"]] = {"name": kw["json"]["name"], "compute_status": {"state": "ACTIVE"}}
            return {"name": kw["json"]["name"]}
        if method == "POST" and path.endswith("/deployments"):
            name = path.split("/")[-2]
            self.apps[name] = {**APP, "name": name}
            return {"deployment_id": "d1"}
        if method == "GET" and path.endswith("/tools"):
            return {"tools": []}
        return {}  # includes PATCH .../unity-catalog/permissions/...

    def of(self, method, frag):
        return [c for c in self.calls if c[0] == method and frag in c[1]]


WHO = {"user_name": "a@x.io", "groups": ["admins"], "is_admin": True}


def wire(fake, in_apps=False):
    for mod in (builder, mcps):
        mod.call = fake
        mod.app_token = lambda: "APP"
    builder.in_apps = lambda: in_apps
    mcps._cache = (time.time(), mcps.parse_catalog(archive(REPO)))
    mcps._progress.clear()
    mcps._archive = lambda: archive(REPO)


@case("start creates a missing app, as the admin, and marks the copy in progress")
def _():
    f = Fake()
    wire(f)
    out = mcps.start("good", WHO, "USER")
    assert out["acted_as"] == "you"
    created = f.of("POST", "/api/2.0/apps")
    assert created and created[0][3]["name"] == "mcp-good" and created[0][2] == "USER"
    assert mcps._progress["mcp-good"]["phase"] == "copying"


@case("a tool that needs secrets: not offered until they exist; then its app gets them as resources")
def _():
    repo = {**REPO, "gam/mcp.yaml": "name: GAM\ntools: [{name: plan}]\nneeds: {secrets: [gam-key, gam-network]}",
            "gam/app.yaml": "command: ['python', 'server.py']"}

    class WithSecrets(Fake):
        def __init__(self, keys):
            super().__init__()
            self.keys = keys

        def __call__(self, method, path, token, **kw):
            if path == "/api/2.0/secrets/list":
                self.calls.append((method, path, token, kw.get("params")))
                return {"secrets": [{"key": k} for k in self.keys]}
            return super().__call__(method, path, token, **kw)

    for keys, connected in ((["gam-key"], False), (["gam-key", "gam-network"], True)):
        f = WithSecrets(keys)
        wire(f)
        mcps._cache = (time.time(), mcps.parse_catalog(archive(repo)))
        mcps._secrets_seen = None
        row = next(r for r in mcps.listing("USER")["mcps"] if r["slug"] == "gam")
        if not connected:
            assert "not connected yet" in row["problem"] and "gam-network" in row["problem"], row["problem"]
            try:
                mcps.start("gam", WHO, "USER")
            except DbxError as exc:
                assert exc.status == 409 and "gam-network" in str(exc)
            else:
                raise AssertionError("installed without its secrets")
            assert not f.of("POST", "/api/2.0/apps")
        else:
            assert not row["problem"], row["problem"]
            mcps.start("gam", WHO, "USER")
            body = f.of("POST", "/api/2.0/apps")[0][3]
            assert body["resources"] == [
                {"name": "gam-key", "secret": {"scope": "agent-portal", "key": "gam-key", "permission": "READ"}},
                {"name": "gam-network", "secret": {"scope": "agent-portal", "key": "gam-network", "permission": "READ"}}]
    # an app made before the secrets were wired gets them added
    f = WithSecrets(["gam-key", "gam-network"])
    f.apps["mcp-gam"] = {"name": "mcp-gam", "compute_status": {"state": "ACTIVE"}, "resources": []}
    wire(f)
    mcps._cache = (time.time(), mcps.parse_catalog(archive(repo)))
    mcps._secrets_seen = None
    mcps.start("gam", WHO, "USER")
    patched = [c for c in f.calls if c[0] == "PATCH" and c[1] == "/api/2.0/apps/mcp-gam"]
    assert patched and len(patched[0][3]["resources"]) == 2
    mcps._secrets_seen = None


@case("start refuses a folder with a problem")
def _():
    wire(Fake())
    try:
        mcps.start("no-app", WHO, "USER")
    except DbxError as exc:
        assert exc.status == 400
    else:
        raise AssertionError("started an undeployable folder")


@case("start on a missing tool is a 404")
def _():
    wire(Fake())
    try:
        mcps.start("nope", WHO, "USER")
    except DbxError as exc:
        assert exc.status == 404
    else:
        raise AssertionError("found a tool that is not there")


@case("when the app identity creates the app, the admin is made its manager")
def _():
    f = Fake()
    wire(f, in_apps=True)
    f.fail[("GET", "/api/2.0/apps/mcp-good")] = DbxError("x", 404)

    real = Fake.__call__

    def scoped(self, method, path, token, **kw):
        if token == "USER" and method in ("POST",) and path == "/api/2.0/apps":
            self.calls.append((method, path, token, kw.get("json")))
            raise DbxError("token does not have required scopes: apps", 403)
        return real(self, method, path, token, **kw)

    Fake.__call__ = scoped
    try:
        out = mcps.start("good", WHO, "USER")
    finally:
        Fake.__call__ = real
    assert out["acted_as"] == "the portal's service identity"
    grant = f.of("PATCH", "/api/2.0/permissions/apps/mcp-good")
    assert grant and grant[0][3]["access_control_list"][0] == {"user_name": "a@x.io", "permission_level": "CAN_MANAGE"}


@case("run copies the files, then submits a deployment pointing at that folder")
def _():
    f = Fake(apps={"mcp-good": {**APP, "app_status": {"state": "UNAVAILABLE"}, "active_deployment": None}})
    wire(f)
    entry = mcps.find("good")
    mcps.run(entry, "USER")
    imports = f.of("POST", "/workspace/import")
    paths = sorted(c[3]["path"] for c in imports)
    base = mcps.SOURCE_ROOT + "/good"
    assert paths == sorted(base + "/" + p for p in ("app.yaml", "data/x.bin", "mcp.yaml", "server.py")), paths
    assert all(c[3]["overwrite"] is True for c in imports)
    dep = f.of("POST", "/apps/mcp-good/deployments")
    assert dep and dep[0][3] == {"source_code_path": base, "mode": "SNAPSHOT"}
    assert mcps._progress["mcp-good"]["phase"] == "submitted"
    # the old copy is cleared first, so a file removed from git is not deployed
    assert f.calls.index(f.of("POST", "/workspace/delete")[0]) < f.calls.index(imports[0])


@case("run records a failure instead of raising, and never deploys")
def _():
    f = Fake()
    f.fail[("POST", "/workspace/import")] = DbxError("no space", 507)
    wire(f)
    mcps.run(mcps.find("good"), "USER")
    p = mcps._progress["mcp-good"]
    assert p["phase"] == "failed" and "no space" in p["message"]
    assert not f.of("POST", "/deployments")


@case("listing joins the catalog with what is deployed, by app name")
def _():
    f = Fake(apps={"mcp-good": APP})
    wire(f)
    rows = {r["slug"]: r for r in mcps.listing("USER")["mcps"]}
    assert rows["good"]["state"] == "running" and rows["good"]["url"] == "https://x"
    assert rows["custom"]["state"] == "not_deployed"


@case("a failed refresh serves the last good list with a note")
def _():
    wire(Fake())
    mcps._cache = (0.0, mcps._cache[1])  # stale

    def down():
        raise DbxError("GitHub answered 503", 502)

    mcps._archive = down
    entries, note = mcps.catalog()
    assert entries and "last list" in note


def tool(slug="good", ref="whatever-the-browser-said"):
    return {"type": "app", "ref": ref, "description": "d", "mcp": slug}


@case("plan: tools not from the catalog pass straight through")
def _():
    wire(Fake())
    t = [{"type": "uc_function", "ref": "a.b.c", "description": ""}]
    assert mcps.plan(t, "USER") == (t, [])


@case("plan: a running tool is attached now, with the app name taken from the catalog")
def _():
    wire(Fake(apps={"mcp-good": APP}))
    now, later = mcps.plan([tool()], "USER")
    assert later == [] and now[0]["ref"] == "mcp-good"


@case("plan: a tool that is not deployed is held back to be deployed")
def _():
    wire(Fake())
    now, later = mcps.plan([tool()], "USER")
    assert now == [] and later[0]["entry"]["slug"] == "good" and later[0]["state"] == "not_deployed"
    assert later[0]["tool"]["ref"] == "mcp-good"


@case("plan: an app still listed but already deleted is treated as not deployed")
def _():
    f = Fake(apps={"mcp-good": APP})
    f.hidden.add("mcp-good")
    wire(f)
    now, later = mcps.plan([tool()], "USER")
    assert now == [] and later[0]["state"] == "not_deployed"


@case("plan: an app Databricks reports as being deleted is treated as not deployed")
def _():
    f = Fake(apps={"mcp-good": {**APP, "compute_status": {"state": "DELETING"}}})
    wire(f)
    now, later = mcps.plan([tool()], "USER")
    assert now == [] and later[0]["state"] == "not_deployed"


@case("deploy_and_attach: waits for a deleted app to finish going away, then sets it up again")
def _():
    f = Fake(apps={"mcp-good": {**APP, "compute_status": {"state": "DELETING"}}})
    wire(f)
    _, later = mcps.plan([tool()], "USER")
    mcps.time.sleep = lambda s: f.apps.pop("mcp-good", None)  # it finally disappears
    mcps.deploy_and_attach("abc123", later, WHO, "USER")
    assert f.of("POST", "/api/2.0/apps")[0][3]["name"] == "mcp-good"  # created anew
    assert f.of("POST", "/deployments") and f.of("POST", "/supervisor-agents/abc123/tools")


@case("plan: an unflagged app tool that matches the catalog is still planned when asked to derive")
def _():
    wire(Fake())
    plain = {"type": "app", "ref": "mcp-good", "description": "d"}
    assert mcps.plan([plain], "USER") == ([plain], [])  # an existing assistant's tools are left alone
    now, later = mcps.plan([plain], "USER", derive=True)
    assert now == [] and later[0]["entry"]["slug"] == "good"
    other = {"type": "app", "ref": "some-other-app", "description": ""}
    assert mcps.plan([other], "USER", derive=True) == ([other], [])


@case("defer: every catalog tool is set aside to be installed; others stay")
def _():
    wire(Fake())
    keep = {"type": "volume", "ref": "c.s.v", "description": ""}
    now, later = mcps.defer([keep, {"type": "app", "ref": "mcp-good", "description": ""}])
    assert now == [keep] and later[0]["entry"]["slug"] == "good" and later[0]["state"] == "not_deployed"


@case("a DELETED app status is also treated as gone")
def _():
    assert mcps._state({**APP, "app_status": {"state": "DELETED"}}, None)[0] == "not_deployed"


@case("the create route retries without a tool whose app Databricks says does not exist")
def _():
    import app as portal
    from fastapi.testclient import TestClient

    wire(Fake(apps={"mcp-good": APP}))  # looks running, so plan attaches it now
    seen = []

    def create(spec, who, tok):
        seen.append([t["type"] + ":" + t["ref"] for t in spec["tools"]])
        if any(t["type"] == "app" for t in spec["tools"]):
            raise DbxError("Could not attach a tool, so nothing was created: POST ... -> 404: "
                           "App with name mcp-good does not exist or is deleted.", 404)
        return {"agent_id": "a1", "endpoint_name": "", "acted_as": "you", "warnings": [], "access_pending": 0}

    background = []
    patched = {
        (portal, "_require_admin"): lambda tok: (WHO, "USER"),
        (portal.builder, "create_agent"): create,
        (portal.builder, "finish_provisioning"): lambda *a: None,
        (portal.mcps, "deploy_and_attach"): lambda aid, pending, who, tok, volumes=None: background.append(
            (aid, [p["entry"]["slug"] for p in pending])),
    }
    saved = {k: getattr(*k) for k in patched}
    try:
        for (mod, name), fn in patched.items():
            setattr(mod, name, fn)
        r = TestClient(portal.app).post("/api/admin/builder/agents", json={
            "display_name": "X", "tools": [{"type": "volume", "ref": "c.s.v"},
                                           {"type": "app", "ref": "mcp-good", "mcp": "good"}]})
    finally:
        for (mod, name), fn in saved.items():
            setattr(mod, name, fn)
    assert r.status_code == 200, r.text
    assert r.json()["deploying"] == ["Report builder"], r.json()
    assert seen == [["volume:c.s.v", "app:mcp-good"], ["volume:c.s.v"]], seen
    assert background == [("a1", ["good"])], background


VOLS = {"read": ["main.sales.uploads"], "write": ["main.sales.results"]}


def grants(f):
    """(securable kind, name, privilege) for every permission change made."""
    out = []
    for c in f.of("PATCH", "/unity-catalog/permissions/"):
        kind, name = c[1].split("/unity-catalog/permissions/")[1].split("/", 1)
        change = c[3]["changes"][0]
        assert change["principal"] == "sp-1", change
        out.append((kind, name, change["add"][0]))
    return out


@case("volumes_for: uploads and folder tools are read, results are write, junk is dropped")
def _():
    v = mcps.volumes_for({"files": {"upload_volume": "c.s.up", "output_volume": "c.s.out"},
                          "tools": [{"type": "volume", "ref": "c.s.docs"}, {"type": "app", "ref": "x"}]})
    assert v == {"read": ["c.s.docs", "c.s.up"], "write": ["c.s.out"]}
    assert mcps.volumes_for({"files": {"upload_volume": "not a volume"}, "tools": []}) == {"read": [], "write": []}


@case("grant_volumes: gives the app read on uploads and write on results, plus the USE grants")
def _():
    f = Fake(apps={"mcp-good": APP})
    wire(f)
    problems = mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert problems == []
    assert sorted(grants(f)) == sorted([
        ("catalog", "main", "USE_CATALOG"), ("schema", "main.sales", "USE_SCHEMA"),
        ("volume", "main.sales.uploads", "READ_VOLUME"), ("volume", "main.sales.results", "READ_VOLUME"),
        ("volume", "main.sales.results", "WRITE_VOLUME")])
    assert all(c[2] == "USER" for c in f.of("PATCH", "/unity-catalog/"))  # as the admin, not the portal


@case("grant_volumes: an app that already exists just gets its permissions topped up")
def _():
    f = Fake(apps={"mcp-good": APP})
    wire(f)
    mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert not f.of("POST", "/api/2.0/apps") and not f.of("POST", "/deployments")  # nothing reinstalled


@case("grant_volumes: a tool that only reads is not given write")
def _():
    f = Fake(apps={"mcp-good": APP})
    wire(f)
    e = {**mcps.find("good"), "needs": {"secrets": [], "volumes": ["read"]}}
    mcps.grant_volumes([e], VOLS, "USER")
    privs = {p for _, _, p in grants(f)}
    assert "WRITE_VOLUME" not in privs and "READ_VOLUME" in privs


@case("grant_volumes: no folders chosen means no grants")
def _():
    f = Fake(apps={"mcp-good": APP})
    wire(f)
    assert mcps.grant_volumes(mcps.users_of_volumes([tool()]), {"read": [], "write": []}, "USER") == []
    assert not f.of("PATCH", "/unity-catalog/")


@case("grant_volumes: a refusal is reported with the grant to make by hand, and the rest still go ahead")
def _():
    f = Fake(apps={"mcp-good": APP})
    f.fail[("PATCH", "/permissions/volume/main.sales.uploads")] = DbxError("PERMISSION_DENIED", 403)
    wire(f)
    problems = mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert len(problems) == 1 and "READ_VOLUME" in problems[0] and "sp-1" in problems[0], problems
    assert ("volume", "main.sales.results", "WRITE_VOLUME") in grants(f)


@case("the app list has no app_status any more: a newer deployment than the active one means it is still going in")
def _():
    base = {"name": "mcp-x", "compute_status": {"state": "ACTIVE"}}
    going_in = {**base, "last_deployment_id": "d2", "active_deployment": {"deployment_id": "d1", "status": {"state": "SUCCEEDED"}}}
    assert mcps._state(going_in, None)[0] == "deploying"
    live = {**base, "last_deployment_id": "d2", "active_deployment": {"deployment_id": "d2", "status": {"state": "SUCCEEDED"}}}
    assert mcps._state(live, None) == ("running", "")
    assert mcps._state({**base, "last_deployment_id": "d1"}, None)[0] == "deploying"  # the first one, not shown yet
    # the single-app read still has app_status, which is trusted first
    assert mcps._state({**going_in, "app_status": {"state": "RUNNING"}}, None) == ("running", "")


@case("grant_volumes on a deployed portal: no UC scope and a refused portal identity fall back to SQL GRANT as the admin")
def _():
    # Seen live (2026-10-08): the admin's token lacked the unity-catalog scope, the portal's identity did
    # not manage the catalog, and every folder grant failed. The admin's `sql` scope can make the grant.
    f = Fake(apps={"mcp-good": APP})
    sql = []

    def fake(method, path, token, **kw):
        if "/unity-catalog/permissions/" in path:
            f.calls.append((method, path, token, kw.get("json")))
            if token == "USER":
                raise DbxError("Provided OAuth token does not have required scopes: unity-catalog", 403)
            raise DbxError("User does not have MANAGE on Catalog 'main'.", 403)
        if path == "/api/2.0/sql/warehouses":
            return {"warehouses": [{"id": "wh-stopped", "state": "STOPPED"}, {"id": "wh-run", "state": "RUNNING"}]}
        if path == "/api/2.0/sql/statements":
            sql.append((token, kw["json"]["warehouse_id"], kw["json"]["statement"]))
            return {"status": {"state": "SUCCEEDED"}}
        return f(method, path, token, **kw)
    wire(fake, in_apps=True)
    mcps._wh_cache.clear()
    problems = mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert problems == [], problems
    assert {(t, w) for t, w, _ in sql} == {("USER", "wh-run")}, sql  # as the admin, on a running warehouse
    assert sorted(s for _, _, s in sql) == sorted([
        "GRANT USE CATALOG ON CATALOG `main` TO `sp-1`", "GRANT USE SCHEMA ON SCHEMA `main`.`sales` TO `sp-1`",
        "GRANT READ VOLUME ON VOLUME `main`.`sales`.`uploads` TO `sp-1`",
        "GRANT READ VOLUME ON VOLUME `main`.`sales`.`results` TO `sp-1`",
        "GRANT WRITE VOLUME ON VOLUME `main`.`sales`.`results` TO `sp-1`"]), sql


@case("grant_volumes: when SQL is refused too, the message keeps both reasons and the grant to make")
def _():
    def fake(method, path, token, **kw):
        if "/unity-catalog/permissions/" in path:
            raise DbxError("User does not have MANAGE on Catalog 'main'.", 403)
        if path == "/api/2.0/sql/warehouses":
            return {"warehouses": [{"id": "wh-run", "state": "RUNNING"}]}
        if path == "/api/2.0/sql/statements":
            return {"status": {"state": "FAILED", "error": {"message": "PERMISSION_DENIED: not an owner"}}}
        return Fake(apps={"mcp-good": APP})(method, path, token, **kw)
    wire(fake)
    mcps._wh_cache.clear()
    problems = mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert problems and all("sp-1" in p for p in problems)
    assert "MANAGE on Catalog" in problems[0] and "not an owner" in problems[0], problems[0]


@case("grant_volumes: an app whose identity cannot be found is reported, not raised")
def _():
    f = Fake(apps={"mcp-good": {**APP, "service_principal_client_id": ""}})
    wire(f)
    problems = mcps.grant_volumes(mcps.users_of_volumes([tool()]), VOLS, "USER")
    assert problems and "identity" in problems[0]
    assert not f.of("PATCH", "/unity-catalog/")


@case("as_catalog_tools: an app tool already on an assistant is recognised by its app name")
def _():
    wire(Fake())
    out = mcps.as_catalog_tools([{"type": "app", "ref": "mcp-good", "description": ""},
                                 {"type": "app", "ref": "other", "description": ""}])
    assert out[0]["mcp"] == "good" and "mcp" not in out[1]


@case("deploy_and_attach: gives the new app its folder access before attaching it")
def _():
    f = Fake()
    wire(f)
    mcps.time.sleep = lambda s: None
    _, later = mcps.plan([tool()], "USER")
    mcps.deploy_and_attach("abc123", later, WHO, "USER", VOLS)
    order = [(c[0], c[1]) for c in f.calls]
    last_grant = max(i for i, c in enumerate(order) if c[0] == "PATCH" and "/unity-catalog/" in c[1])
    attach = order.index(("POST", "/api/2.1/supervisor-agents/abc123/tools"))
    assert len(grants(f)) == 5 and last_grant < attach


@case("create and save both top up folder access for a tool that is already running")
def _():
    import app as portal
    from fastapi.testclient import TestClient

    wire(Fake(apps={"mcp-good": APP}))
    granted = []
    ok = {"agent_id": "a1", "endpoint_name": "", "acted_as": "you", "warnings": [], "access_pending": 0}
    patched = {
        (portal, "_require_admin"): lambda tok: (WHO, "USER"),
        (portal.builder, "create_agent"): lambda spec, who, tok: ok,
        (portal.builder, "update_agent"): lambda aid, spec, who, tok: {"agent_id": aid, "acted_as": "you", "warnings": []},
        (portal.builder, "finish_provisioning"): lambda *a: None,
        (portal.mcps, "grant_volumes"): lambda entries, vols, tok: granted.append(([e["slug"] for e in entries], vols)) or ["could not grant X"],
    }
    saved = {k: getattr(*k) for k in patched}
    files = {"upload_volume": "main.sales.uploads", "output_volume": "main.sales.results", "accepts": ""}
    try:
        for (mod, name), fn in patched.items():
            setattr(mod, name, fn)
        c = TestClient(portal.app)
        r1 = c.post("/api/admin/builder/agents", json={
            "display_name": "X", "files": files, "tools": [{"type": "app", "ref": "mcp-good", "mcp": "good"}]})
        # editing: the tool comes back from Databricks without the catalog flag
        r2 = c.put("/api/admin/builder/agents/a1", json={
            "display_name": "X", "files": files, "tools": [{"type": "app", "ref": "mcp-good"}]})
        # no folders chosen: nothing to grant
        r3 = c.put("/api/admin/builder/agents/a1", json={
            "display_name": "X", "tools": [{"type": "app", "ref": "mcp-good"}]})
    finally:
        for (mod, name), fn in saved.items():
            setattr(mod, name, fn)
    assert r1.status_code == r2.status_code == r3.status_code == 200, (r1.text, r2.text, r3.text)
    assert r1.json()["warnings"] == ["could not grant X"] and r3.json()["warnings"] == []  # problems reach the screen
    want = (["good"], {"read": ["main.sales.uploads"], "write": ["main.sales.results"]})
    assert granted == [want, want], granted


@case("install: a second request for the same app does nothing while the first is working")
def _():
    f = Fake()
    wire(f)
    mcps._installing.add("mcp-good")
    try:
        assert mcps.install(mcps.find("good"), WHO, "USER") is False
    finally:
        mcps._installing.discard("mcp-good")
    assert not f.of("POST", "/api/2.0/apps")


@case("install: creates and deploys the app, and lets go of the app afterwards")
def _():
    f = Fake()
    wire(f)
    assert mcps.install(mcps.find("good"), WHO, "USER") is True
    assert f.of("POST", "/api/2.0/apps") and f.of("POST", "/deployments")
    assert "mcp-good" not in mcps._installing


@case("install: a failure is recorded for the tool, re-raised, and lets go of the app")
def _():
    f = Fake()
    f.fail[("POST", "/api/2.0/apps")] = DbxError("not allowed to create apps", 403)
    wire(f)
    try:
        mcps.install(mcps.find("good"), WHO, "USER")
    except DbxError:
        pass
    else:
        raise AssertionError("swallowed the failure")
    assert mcps._progress["mcp-good"]["phase"] == "failed" and "not allowed" in mcps._progress["mcp-good"]["message"]
    assert "mcp-good" not in mcps._installing


@case("prepare: only tools that are not running are installed, and shown as getting ready at once")
def _():
    f = Fake(apps={"mcp-good": {**APP}})
    wire(f)
    assert mcps.prepare(["good"], "USER") == []  # already running: nothing to do
    f2 = Fake()
    wire(f2)
    started = mcps.prepare(["good", "good"], "USER")
    assert [e["slug"] for e in started] == ["good"]
    assert mcps._progress["mcp-good"]["phase"] == "copying"
    assert mcps._state(None, mcps._progress["mcp-good"])[0] == "deploying"


@case("prepare: an earlier failure is cleared so a retry is not met with the old error")
def _():
    f = Fake()
    wire(f)
    mcps._progress["mcp-good"] = {"phase": "failed", "message": "old error", "at": time.time()}
    assert mcps._state(None, mcps._progress["mcp-good"])[0] == "failed"
    mcps.prepare(["good"], "USER")
    assert mcps._state(None, mcps._progress["mcp-good"])[0] == "deploying"


@case("install: waits for a deleted app to go away before recreating it")
def _():
    f = Fake(apps={"mcp-good": {**APP, "compute_status": {"state": "DELETING"}}})
    wire(f)
    mcps.time.sleep = lambda s: f.apps.pop("mcp-good", None)
    assert mcps.install(mcps.find("good"), WHO, "USER") is True
    assert f.of("POST", "/api/2.0/apps")[0][3]["name"] == "mcp-good"


@case("the prepare route starts the install in the background and names what it is getting ready")
def _():
    import app as portal
    from fastapi.testclient import TestClient

    wire(Fake())
    queued = []
    patched = {
        (portal, "_require_admin"): lambda tok: (WHO, "USER"),
        (portal.mcps, "install_quietly"): lambda entry, who, tok: queued.append(entry["slug"]),
    }
    saved = {k: getattr(*k) for k in patched}
    try:
        for (mod, name), fn in patched.items():
            setattr(mod, name, fn)
        c = TestClient(portal.app)
        ok = c.post("/api/admin/builder/mcps/prepare", json={"slugs": ["good"]})
        none = c.post("/api/admin/builder/mcps/prepare", json={"slugs": []})
        bad = c.post("/api/admin/builder/mcps/prepare", json={"slugs": ["no-app"]})
    finally:
        for (mod, name), fn in saved.items():
            setattr(mod, name, fn)
    assert ok.status_code == 200 and ok.json() == {"preparing": ["Report builder"]}, ok.text
    assert queued == ["good"]
    assert none.status_code == 400 and bad.status_code == 400


def stepper(f, name, states):
    """A sleep that moves the app through these compute states, one per wait."""
    seq = iter(states)

    def tick(_s):
        f.apps[name] = {**f.apps.get(name, {"name": name}), "compute_status": {"state": next(seq)}}

    return tick


@case("run: waits for a new app to start before deploying (the 'not in RUNNING state' failure)")
def _():
    f = Fake(apps={"mcp-good": {"name": "mcp-good", "compute_status": {"state": "STARTING"}}})
    wire(f)
    mcps.time.sleep = stepper(f, "mcp-good", ["STARTING", "ACTIVE"])
    mcps.run(mcps.find("good"), "USER")
    order = [(c[0], c[1]) for c in f.calls]
    assert ("POST", "/api/2.0/apps/mcp-good/deployments") in order
    first_dep = order.index(("POST", "/api/2.0/apps/mcp-good/deployments"))
    assert [c for c in order[:first_dep] if c == ("GET", "/api/2.0/apps/mcp-good")], "never checked the app first"
    assert mcps._progress["mcp-good"]["phase"] == "submitted"


@case("run: an app that is switched off is started once, then waited for")
def _():
    f = Fake(apps={"mcp-good": {"name": "mcp-good", "compute_status": {"state": "STOPPED"}}})
    wire(f)
    mcps.time.sleep = stepper(f, "mcp-good", ["STARTING", "ACTIVE"])
    mcps.run(mcps.find("good"), "USER")
    assert len(f.of("POST", "/apps/mcp-good/start")) == 1
    assert f.of("POST", "/deployments")


@case("run: an app whose compute fails to start is reported with Databricks' reason, not deployed")
def _():
    f = Fake(apps={"mcp-good": {"name": "mcp-good", "compute_status": {"state": "ERROR", "message": "no capacity"}}})
    wire(f)
    mcps.time.sleep = lambda s: None
    mcps.run(mcps.find("good"), "USER")
    p = mcps._progress["mcp-good"]
    assert p["phase"] == "failed" and "no capacity" in p["message"], p
    assert not f.of("POST", "/deployments")


@case("run: gives up waiting for an app that never starts")
def _():
    f = Fake(apps={"mcp-good": {"name": "mcp-good", "compute_status": {"state": "STARTING"}}})
    wire(f)
    clock = [1000.0]
    real_time, real_sleep = mcps.time.time, mcps.time.sleep
    mcps.time.time = lambda: clock[0]
    mcps.time.sleep = lambda s: clock.__setitem__(0, clock[0] + 120)
    try:
        mcps.run(mcps.find("good"), "USER")
    finally:
        mcps.time.time, mcps.time.sleep = real_time, real_sleep
    assert mcps._progress["mcp-good"]["phase"] == "failed" and "did not start" in mcps._progress["mcp-good"]["message"]
    assert not f.of("POST", "/deployments")


@case("run: retries a deployment Databricks refuses as 'not in RUNNING state', then succeeds")
def _():
    f = Fake(apps={"mcp-good": {**APP}})
    wire(f)
    mcps.time.sleep = lambda s: None
    refuse = [DbxError("POST ... -> 400: Cannot deploy app as it is not in RUNNING state.", 400)] * 2
    real = Fake.__call__

    def flaky(self, method, path, token, **kw):
        if method == "POST" and path.endswith("/deployments") and refuse:
            self.calls.append((method, path, token, kw.get("json")))
            raise refuse.pop()
        return real(self, method, path, token, **kw)

    Fake.__call__ = flaky
    try:
        mcps.run(mcps.find("good"), "USER")
    finally:
        Fake.__call__ = real
    assert len(f.of("POST", "/deployments")) == 3 and mcps._progress["mcp-good"]["phase"] == "submitted"


@case("run: any other deployment refusal is not retried")
def _():
    f = Fake(apps={"mcp-good": {**APP}})
    f.fail[("POST", "/deployments")] = DbxError("POST ... -> 400: invalid source path", 400)
    wire(f)
    mcps.time.sleep = lambda s: None
    mcps.run(mcps.find("good"), "USER")
    assert len(f.of("POST", "/deployments")) == 1 and mcps._progress["mcp-good"]["phase"] == "failed"


@case("plan: an unknown or undeployable tool is a 400, and nothing is deployed")
def _():
    f = Fake()
    wire(f)
    for slug in ("nope", "no-app"):
        try:
            mcps.plan([tool(slug)], "USER")
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + slug)
    assert not f.of("POST", "")


@case("a catalog flag is only accepted on app tools with a folder-shaped name")
def _():
    ok = builder.clean_spec({"display_name": "x", "tools": [{"type": "app", "ref": "mcp-good", "mcp": "good"}]})
    assert ok["tools"][0]["mcp"] == "good"
    for bad in ({"type": "volume", "ref": "c.s.v", "mcp": "good"}, {"type": "app", "ref": "a", "mcp": "../x"}):
        try:
            builder.clean_spec({"display_name": "x", "tools": [bad]})
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad))


@case("deploy_and_attach: deploys the missing tool, waits for it, then adds it to the assistant")
def _():
    f = Fake()
    wire(f)
    mcps.time.sleep = lambda s: None
    _, later = mcps.plan([tool()], "USER")
    mcps.deploy_and_attach("abc123", later, WHO, "USER")
    order = [(c[0], c[1]) for c in f.calls]
    dep = order.index(("POST", "/api/2.0/apps/mcp-good/deployments"))
    add = order.index(("POST", "/api/2.1/supervisor-agents/abc123/tools"))
    assert dep < add
    body = f.of("POST", "/supervisor-agents/abc123/tools")[0][3]
    assert body["tool_type"] == "app" and body["app"] == {"name": "mcp-good"}


@case("deploy_and_attach: a tool Databricks is already deploying is waited for, not deployed again")
def _():
    f = Fake(apps={"mcp-good": {**APP, "app_status": {"state": "DEPLOYING"},
                                "pending_deployment": {"status": {"state": "IN_PROGRESS"}}}})
    wire(f)
    _, later = mcps.plan([tool()], "USER")
    assert later[0]["state"] == "deploying"
    mcps.time.sleep = lambda s: f.apps.update({"mcp-good": {**APP}})  # it finishes while we wait
    mcps.deploy_and_attach("abc123", later, WHO, "USER")
    assert not f.of("POST", "/deployments")
    assert f.of("POST", "/supervisor-agents/abc123/tools")


@case("deploy_and_attach: if another request is already installing it, wait instead of installing twice")
def _():
    f = Fake()
    wire(f)
    _, later = mcps.plan([tool()], "USER")
    mcps._installing.add("mcp-good")

    def other_request_finishes(_s):
        mcps._installing.discard("mcp-good")
        f.apps["mcp-good"] = {**APP}

    mcps.time.sleep = other_request_finishes
    mcps.deploy_and_attach("abc123", later, WHO, "USER")
    assert not f.of("POST", "/deployments")
    assert f.of("POST", "/supervisor-agents/abc123/tools")


@case("deploy_and_attach: a failed deploy adds nothing and does not raise")
def _():
    f = Fake()
    f.fail[("POST", "/workspace/import")] = DbxError("no space", 507)
    wire(f)
    mcps.time.sleep = lambda s: None
    _, later = mcps.plan([tool()], "USER")
    mcps.deploy_and_attach("abc123", later, WHO, "USER")
    assert not f.of("POST", "/supervisor-agents/abc123/tools")


@case("state: a deployment Databricks failed to copy is a failure; a newer one going in, or one just resubmitted, is not")
def _():
    msg = "Error downloading source code. Error: error listing files: request timed out after 1m0s of inactivity"
    base = {"name": "mcp-x", "compute_status": {"state": "ACTIVE"}, "last_deployment_id": "d1",
            "active_deployment": {"deployment_id": "d1", "status": {"state": "FAILED", "message": msg}}}
    assert mcps._state(base, None) == ("failed", msg)
    assert mcps._state({**base, "last_deployment_id": "d2"}, None)[0] == "deploying"      # a newer one is going in
    assert mcps._state({**base, "app_status": {"state": "RUNNING"}}, None) == ("running", "")
    again = {"phase": "submitted", "message": "Installing it.", "at": time.time()}
    assert mcps._state(base, again)[0] == "deploying"                                       # submitted again a moment ago
    old = {**again, "at": time.time() - 300}
    assert mcps._state(base, old)[0] == "failed"                                            # and not for ever
    assert mcps.transient(msg) and mcps.transient("The request timed out") and mcps.transient("HTTP 503")
    assert not mcps.transient("requirements.txt: no matching distribution found for nosuchpkg")


def main() -> int:
    passed = failed = 0
    for name, fn in CASES:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - test harness
            print("  FAIL  " + name)
            print("        " + type(exc).__name__ + ": " + str(exc)[:220])
            failed += 1
        else:
            print("  PASS  " + name)
            passed += 1
    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
