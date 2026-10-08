"""Builder tests - run against a fake Databricks, no workspace needed.

Run: python test_builder.py

These pin the behaviours that would be costly to get wrong: the all-or-nothing
create, the scope-only identity fallback, and edits that must not touch tools the
builder does not understand.
"""
from __future__ import annotations

import builder
from dbx import DbxError

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


class Fake:
    """Records calls and plays back scripted failures. Stands in for dbx.call."""

    def __init__(self):
        self.calls = []
        self.fail = {}  # (method, path-substring) -> DbxError
        self.tools = []  # tools returned by GET .../tools
        self.acl = []

    def __call__(self, method, path, token, **kw):
        self.calls.append((method, path, token, kw.get("params"), kw.get("json")))
        for (m, frag), exc in self.fail.items():
            if m == method and frag in path:
                raise exc
        if method == "POST" and path.endswith("/supervisor-agents"):
            return {"supervisor_agent_id": "abc123", "endpoint_name": "mas-abc-endpoint"}
        if method == "GET" and path.endswith("/tools"):
            return {"tools": self.tools}
        if method == "GET" and "/permissions/supervisor-agents/" in path:
            return {"access_control_list": self.acl}
        return {}

    def methods(self, method, frag=""):
        return [c for c in self.calls if c[0] == method and frag in c[1]]


WHO = {"user_name": "a@x.io", "groups": ["admins"], "is_admin": True}


def run(fake, fn, *a, in_apps=False):
    builder.call = fake
    builder.app_token = lambda: "APP"
    builder.in_apps = lambda: in_apps
    builder._portal_sp = lambda tok: ""
    return fn(*a)


SPEC = {"display_name": "Weather", "description": "d", "instructions": "i",
        "tools": [{"type": "uc_function", "ref": "weather_agent.weather.get_forecast", "description": "fc"},
                  {"type": "genie_space", "ref": "01ef-abc", "description": ""}]}


@case("clean_spec rejects a missing name and a malformed UC reference")
def _():
    for bad in ({"display_name": ""},
                {"display_name": "x", "tools": [{"type": "uc_function", "ref": "just_a_name"}]},
                {"display_name": "x", "tools": [{"type": "nonsense", "ref": "a"}]}):
        try:
            builder.clean_spec(bad)
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad))


@case("clean_spec drops duplicate tools and blank descriptions stay blank")
def _():
    s = builder.clean_spec({"display_name": "x", "tools": [
        {"type": "volume", "ref": "c.s.v"}, {"type": "volume", "ref": "c.s.v"}]})
    assert len(s["tools"]) == 1 and s["tools"][0]["description"] == ""


@case("tool ids are 4-63 chars, valid, and unique even for similar refs")
def _():
    used = set()
    ids = [builder._tool_id("uc_function", "a.b.c", used) for _ in range(3)]
    ids.append(builder._tool_id("app", "x" * 200, used))
    assert len(set(ids)) == 4
    assert all(4 <= len(i) <= 63 and all(ch.isalnum() or ch in "-._" for ch in i) for i in ids)


@case("create sends each tool with its documented nested spec")
def _():
    f = Fake()
    out = run(f, builder.create_agent, builder.clean_spec(SPEC), WHO, "USER")
    posts = f.methods("POST", "/tools")
    assert len(posts) == 2
    assert posts[0][4] == {"tool_type": "uc_function",
                           "uc_function": {"name": "weather_agent.weather.get_forecast"},
                           "description": "fc"}
    assert posts[1][4] == {"tool_type": "genie_space", "genie_space": {"id": "01ef-abc"}}
    assert out["agent_id"] == "abc123" and out["acted_as"] == "you"
    assert f.methods("DELETE") == []


@case("create is all-or-nothing: a rejected tool deletes the new agent")
def _():
    f = Fake()
    f.fail[("POST", "/tools")] = DbxError("bad tool", 400)
    try:
        run(f, builder.create_agent, builder.clean_spec(SPEC), WHO, "USER")
    except DbxError as exc:
        assert "nothing was created" in str(exc)
    else:
        raise AssertionError("did not raise")
    assert len(f.methods("DELETE", "/supervisor-agents/abc123")) == 1


@case("identity falls back to the app ONLY for a missing-scope refusal, inside Apps")
def _():
    f = Fake()
    f.fail[("POST", "/supervisor-agents")] = DbxError("Provided OAuth token does not have required scopes: supervisor-agents", 403)
    # Make the user's token fail but not the app's.
    orig = f.__call__

    def picky(method, path, token, **kw):
        if token == "USER" and method == "POST" and path.endswith("/supervisor-agents"):
            raise DbxError("token does not have required scopes", 403)
        return Fake.__call__(f, method, path, token, **kw)

    f.fail.clear()
    out = run(picky, builder.create_agent, builder.clean_spec({"display_name": "x"}), WHO, "USER", in_apps=True)
    assert out["acted_as"] == "the portal's service identity"


@case("a genuine permission denial is NOT retried as the app")
def _():
    f = Fake()
    f.fail[("POST", "/supervisor-agents")] = DbxError("PERMISSION_DENIED: feature not enabled", 403)
    try:
        run(f, builder.create_agent, builder.clean_spec({"display_name": "x"}), WHO, "USER", in_apps=True)
    except DbxError as exc:
        assert exc.status == 403
    else:
        raise AssertionError("did not raise")
    assert all(c[2] == "USER" for c in f.calls), "retried under another identity"


@case("a scope refusal outside Apps is not retried (local dev has one identity)")
def _():
    f = Fake()
    f.fail[("POST", "/supervisor-agents")] = DbxError("does not have required scopes", 403)
    try:
        run(f, builder.create_agent, builder.clean_spec({"display_name": "x"}), WHO, "USER", in_apps=False)
    except DbxError:
        pass
    else:
        raise AssertionError("did not raise")
    assert len(f.calls) == 1


@case("update refuses someone who lacks CAN_MANAGE on the agent")
def _():
    f = Fake()
    f.acl = [{"user_name": "other@x.io", "all_permissions": [{"permission_level": "CAN_MANAGE"}]}]
    try:
        run(f, builder.update_agent, "abc123", builder.clean_spec(SPEC), WHO, "USER")
    except DbxError as exc:
        assert exc.status == 403
    else:
        raise AssertionError("did not raise")
    assert f.methods("PATCH", "/supervisor-agents/abc123") == []


@case("update adds new tools, removes dropped ones, and leaves unknown types alone")
def _():
    f = Fake()
    f.acl = [{"user_name": "a@x.io", "all_permissions": [{"permission_level": "CAN_MANAGE"}]}]
    f.tools = [
        {"tool_id": "t-old", "tool_type": "volume", "volume": {"name": "c.s.old"}},
        {"tool_id": "t-keep", "tool_type": "genie_space", "genie_space": {"id": "01ef-abc"}, "description": "old"},
        {"tool_id": "t-mystery", "tool_type": "dashboard", "dashboard": {"x": 1}},
    ]
    run(f, builder.update_agent, "abc123", builder.clean_spec(SPEC), WHO, "USER")
    deletes = [c[1] for c in f.methods("DELETE")]
    assert deletes == ["/api/2.1/supervisor-agents/abc123/tools/t-old"], deletes
    assert len(f.methods("POST", "/tools")) == 1  # only the new uc_function
    redesc = [c for c in f.methods("PATCH", "/tools/t-keep")]
    assert len(redesc) == 1 and redesc[0][4] == {"description": ""}


@case("no tool cap, and the tools list is read across pages (Databricks returns 100 at a time)")
def _():
    many = [{"type": "uc_function", "ref": "c.s.f%03d" % i, "description": ""} for i in range(130)]
    assert len(builder.clean_spec({"display_name": "x", "tools": many})["tools"]) == 130

    pages = {"": {"tools": [{"tool_id": "t%d" % i} for i in range(100)], "next_page_token": "p2"},
             "p2": {"tools": [{"tool_id": "t%d" % i} for i in range(100, 123)]}}
    asked = []

    def paged(method, path, token, **kw):
        asked.append((kw.get("params") or {}).get("page_token", ""))
        return pages[asked[-1]]

    tools, _ = run(paged, builder.list_tools, "abc123", "USER")
    assert len(tools) == 123, len(tools)
    assert asked == ["", "p2"], asked


@case("invalid agent ids cannot reach the URL")
def _():
    for bad in ("../x", "a/b", "", "a b"):
        try:
            builder._check_id(bad)
        except DbxError:
            continue
        raise AssertionError("accepted " + repr(bad))


@case("source listing failure degrades to a note, not an error")
def _():
    f = Fake()
    f.fail[("GET", "/functions")] = DbxError("403 no scope", 403)
    r = run(f, builder.sources, "uc_function", "USER", "c", "s")
    assert r["items"] == [] and "type the name" in r["note"] and "USE SCHEMA on c.s" in r["note"]

@case("folders for a deployed portal: volumes refused for want of a scope are listed through SQL as the person")
def _():
    seen = []

    def call(method, path, tok, **kw):
        seen.append((method, path, tok))
        if path.endswith("/volumes"):
            raise DbxError("Provided OAuth token does not have required scopes: unity-catalog", 403)
        if path == "/api/2.0/sql/warehouses":
            return {"warehouses": [{"id": "w-stopped", "state": "STOPPED"}, {"id": "w-run", "state": "RUNNING"}]}
        if path == "/api/2.0/sql/statements":
            assert kw["json"]["warehouse_id"] == "w-run" and kw["json"]["statement"] == "SHOW VOLUMES IN `main`.`team`"
            return {"status": {"state": "SUCCEEDED"}, "manifest": {"schema": {"columns": [{"name": "database"}, {"name": "volume_name"}]}},
                    "result": {"data_array": [["team", "uploads"], ["team", "adbook"]]}}
        raise AssertionError(path)
    saved = builder.call
    builder.call = call
    try:
        r = builder.sources("volume", "USER", "main", "team")
    finally:
        builder.call = saved
    assert [i["value"] for i in r["items"]] == ["main.team.adbook", "main.team.uploads"], r
    assert all(t == "USER" for _, _, t in seen)  # never the portal's own identity
    assert builder._volumes_via_sql("main", "bad name;", "USER") is None


@case("files: volumes must be catalog.schema.volume; extensions are normalised")
def _():
    f = builder.clean_spec({"display_name": "x", "files": {
        "upload_volume": "c.s.in", "output_volume": "c.s.out", "accepts": ".XLSX, csv ,xlsx"}})["files"]
    assert f == {"upload_volume": "c.s.in", "output_volume": "c.s.out", "accepts": "xlsx, csv"}, f
    for bad in ({"output_volume": "/Volumes/c/s/v"}, {"upload_volume": "c.s"}, {"accepts": "x/../y"}):
        try:
            builder.clean_spec({"display_name": "x", "files": bad})
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad))


@case("file tags: explicit upload volume wins; a volume tool is the fallback; output never inferred")
def _():
    t = builder.file_tags(builder.clean_spec({"display_name": "x", "files": {"upload_volume": "c.s.in"},
                                              "tools": [{"type": "volume", "ref": "c.s.other"}]}))
    assert t["upload_volume"] == "c.s.in" and t["output_volume"] == ""
    t = builder.file_tags(builder.clean_spec({"display_name": "x", "tools": [{"type": "volume", "ref": "c.s.other"}]}))
    assert t["upload_volume"] == "c.s.other" and t["output_volume"] == ""


@case("update writes file tags to the endpoint, and clearing a field deletes its tag")
def _():
    f = Fake()
    f.acl = [{"user_name": "a@x.io", "all_permissions": [{"permission_level": "CAN_MANAGE"}]}]
    orig_get = Fake.__call__
    def withep(method, path, token, **kw):
        if method == "GET" and path == "/api/2.1/supervisor-agents/abc123":
            f.calls.append((method, path, token, None, None)); return {"endpoint_name": "mas-x-endpoint"}
        return orig_get(f, method, path, token, **kw)
    import access
    access.call = withep
    spec = builder.clean_spec({"display_name": "x", "files": {"output_volume": "c.s.out"}})
    out = run(withep, builder.update_agent, "abc123", spec, WHO, "USER")
    tag_call = [c for c in f.calls if c[0] == "PATCH" and c[1].endswith("/tags")][0]
    body = tag_call[4]
    assert body["add_tags"] == [{"key": "output_volume", "value": "c.s.out"}], body
    assert set(body["delete_tags"]) == {"upload_volume", "accepts"}, body
    assert out["warnings"] == []


@case("access: only groups and users, deduplicated, validated")
def _():
    s = builder.clean_spec({"display_name": "x", "access": [
        {"kind": "group", "principal": "finance"}, {"kind": "group", "principal": "finance"},
        {"kind": "user", "principal": "a@x.io"}]})
    assert s["access"] == [{"kind": "group", "principal": "finance"}, {"kind": "user", "principal": "a@x.io"}]
    for bad in ([{"kind": "service_principal", "principal": "x"}], [{"kind": "user", "principal": ""}],
                [{"kind": "group", "principal": "a\nb"}]):
        try:
            builder.clean_spec({"display_name": "x", "access": bad})
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad))
    assert builder.clean_spec({"display_name": "x"})["access"] == []


@case("once the endpoint exists, each chosen team/person gets CAN_QUERY; one failure does not stop the rest")
def _():
    import access
    granted = []

    def fake_grant(target, kind, principal, level, tok):
        if principal == "ghost@x.io":
            raise DbxError("no such user", 404)
        granted.append((target, kind, principal, level))
        return {}

    def fake_call(method, path, tok, **kw):
        if method == "GET" and "/serving-endpoints/" in path:
            return {"id": "ep9"}
        return {}

    access.set_grant = fake_grant
    access.call = fake_call
    builder.call = fake_call
    builder.app_token = lambda: "APP"
    builder.in_apps = lambda: False
    builder._portal_sp = lambda t: ""
    spec = builder.clean_spec({"display_name": "x", "access": [
        {"kind": "group", "principal": "finance"}, {"kind": "user", "principal": "ghost@x.io"},
        {"kind": "user", "principal": "asha@x.io"}]})
    builder.finish_provisioning("agent1", "mas-x-endpoint", spec, {"user_name": "a@x"})
    assert [(g[1], g[2], g[3]) for g in granted] == [("group", "finance", "CAN_QUERY"), ("user", "asha@x.io", "CAN_QUERY")], granted
    assert granted[0][0] == {"id": "ep9", "agent_id": "agent1"}


@case("create reports how many grants are pending, and update ignores access")
def _():
    f = Fake()
    out = run(f, builder.create_agent, builder.clean_spec(
        {"display_name": "x", "access": [{"kind": "group", "principal": "g"}]}), WHO, "USER")
    assert out["access_pending"] == 1
    # no grant is attempted synchronously (the endpoint does not exist yet)
    assert not [c for c in f.calls if "/permissions/serving-endpoints/" in c[1]]


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
