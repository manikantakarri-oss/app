"""Genie builder tests - against a fake Databricks, no workspace needed.

Run: python test_genie.py
"""
from __future__ import annotations

import json
import re

import builder
import genie
from dbx import DbxError

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


class Fake:
    def __init__(self):
        self.calls = []
        self.fail = {}
        self.current = {}  # what GET space returns

    def __call__(self, method, path, token, **kw):
        self.calls.append((method, path, token, kw.get("params"), kw.get("json")))
        for (m, frag), exc in self.fail.items():
            if m == method and frag in path:
                raise exc
        if method == "POST" and path.endswith("/genie/spaces"):
            return {"space_id": "sp123"}
        if method == "POST" and path.endswith("/supervisor-agents"):
            return {"supervisor_agent_id": "ag1", "endpoint_name": "mas-ag1-endpoint"}
        if method == "GET" and "/genie/spaces/" in path:
            return self.current
        return {}

    def of(self, method, frag=""):
        return [c for c in self.calls if c[0] == method and frag in c[1]]


WHO = {"user_name": "a@x.io", "groups": ["admins"], "is_admin": True}
GOOD = {"title": "Sales Data", "description": "Sales questions", "warehouse_id": "wh1234",
        "tables": ["main.sales.orders", "main.sales.customers"],
        "sample_questions": ["Total sales last month?", "Top 5 customers"], "notes": "Fiscal year starts in April."}


def wire(fake, in_apps=False):
    builder.call = fake
    genie.call = fake
    builder.app_token = lambda: "APP"
    builder.in_apps = lambda: in_apps
    builder._portal_sp = lambda t: ""


@case("clean rejects a missing name, warehouse or tables, and malformed table names")
def _():
    for bad in ({**GOOD, "title": ""}, {**GOOD, "warehouse_id": ""}, {**GOOD, "tables": []},
                {**GOOD, "tables": ["just_a_table"]}, {**GOOD, "tables": ["a.b"]}):
        try:
            genie.clean(bad)
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad)[:80])


@case("clean drops duplicate tables and questions; chat defaults on")
def _():
    s = genie.clean({**GOOD, "tables": ["a.b.c", "a.b.c"], "sample_questions": ["q", "q", " "]})
    assert s["tables"] == ["a.b.c"] and s["sample_questions"] == ["q"] and s["chat"] is True


@case("serialize: version 2, 32-hex unique ids, everything sorted, tables as identifiers")
def _():
    doc = json.loads(genie.serialize(genie.clean(GOOD)))
    assert doc["version"] == 2
    qs = doc["config"]["sample_questions"]
    assert len(qs) == 2 and all(re.fullmatch(r"[0-9a-f]{32}", q["id"]) for q in qs)
    assert len({q["id"] for q in qs}) == 2 and [q["id"] for q in qs] == sorted(q["id"] for q in qs)
    assert all(isinstance(q["question"], list) for q in qs)
    assert [t["identifier"] for t in doc["data_sources"]["tables"]] == ["main.sales.customers", "main.sales.orders"]
    ti = doc["instructions"]["text_instructions"]
    assert len(ti) == 1 and ti[0]["content"] == ["Fiscal year starts in April."]


@case("serialize on edit keeps what the builder does not model, and existing question ids")
def _():
    base = {"version": 2,
            "config": {"sample_questions": [{"id": "a" * 32, "question": ["Top 5 customers"]}], "other": 1},
            "data_sources": {"tables": [{"identifier": "main.sales.orders", "column_configs": [{"column_name": "x"}]}],
                             "metric_views": [{"identifier": "m.v.w"}]},
            "instructions": {"join_specs": [{"id": "j"}], "text_instructions": [{"id": "b" * 32, "content": ["old"]}]},
            "benchmarks": {"questions": [{"id": "z"}]}}
    doc = json.loads(genie.serialize(genie.clean(GOOD), base))
    assert doc["benchmarks"] == {"questions": [{"id": "z"}]}
    assert doc["instructions"]["join_specs"] == [{"id": "j"}]
    assert doc["data_sources"]["metric_views"] == [{"identifier": "m.v.w"}]
    assert doc["config"]["other"] == 1
    kept = [q for q in doc["config"]["sample_questions"] if q["question"] == ["Top 5 customers"]][0]
    assert kept["id"] == "a" * 32
    orders = [t for t in doc["data_sources"]["tables"] if t["identifier"] == "main.sales.orders"][0]
    assert orders["column_configs"] == [{"column_name": "x"}]
    assert doc["instructions"]["text_instructions"][0]["id"] == "b" * 32
    assert doc["instructions"]["text_instructions"][0]["content"] == ["Fiscal year starts in April."]


@case("clearing the note removes only the note")
def _():
    base = {"instructions": {"text_instructions": [{"id": "b" * 32, "content": ["old"]}]}}
    doc = json.loads(genie.serialize(genie.clean({**GOOD, "notes": ""}), base))
    assert doc["instructions"]["text_instructions"] == []


@case("unpack reads the editor fields back out of a space")
def _():
    s = genie.serialize(genie.clean(GOOD))
    u = genie._unpack({"space_id": "sp1", "title": "T", "description": "D", "warehouse_id": "w", "serialized_space": s, "etag": "e1"})
    assert u["tables"] == ["main.sales.customers", "main.sales.orders"]
    assert sorted(u["sample_questions"]) == ["Top 5 customers", "Total sales last month?"]
    assert u["notes"] == "Fiscal year starts in April." and u["etag"] == "e1"


@case("create posts the space, then gives each team/person CAN_RUN one by one")
def _():
    f = Fake()
    wire(f)
    spec = genie.clean({**GOOD, "chat": False, "access": [
        {"kind": "group", "principal": "finance"}, {"kind": "user", "principal": "asha@x.io"}]})
    out = genie.create(spec, WHO, "USER")
    post = f.of("POST", "/genie/spaces")[0]
    assert post[4]["title"] == "Sales Data" and post[4]["warehouse_id"] == "wh1234"
    json.loads(post[4]["serialized_space"])
    grants = f.of("PATCH", "/permissions/genie/sp123")
    assert [g[4]["access_control_list"][0] for g in grants] == [
        {"group_name": "finance", "permission_level": "CAN_RUN"},
        {"user_name": "asha@x.io", "permission_level": "CAN_RUN"}]
    assert out["space_id"] == "sp123" and out["chat"] is False and out["warnings"] == []


@case("a failed share is a warning, not a failure, and the others still go through")
def _():
    f = Fake()
    f.fail[("PATCH", "/permissions/genie/")] = DbxError("nope", 403)
    wire(f)
    out = genie.create(genie.clean({**GOOD, "chat": False, "access": [{"kind": "group", "principal": "g"}]}), WHO, "USER")
    assert out["space_id"] == "sp123" and len(out["warnings"]) == 1 and "Share" in out["warnings"][0]


@case("chat on: also creates a one-tool supervisor around the space and returns what provisioning needs")
def _():
    f = Fake()
    wire(f)
    out = genie.create(genie.clean({**GOOD, "access": [{"kind": "group", "principal": "g"}]}), WHO, "USER")
    assert out["chat"] is True and out["access_pending"] == 1
    tool = f.of("POST", "/supervisor-agents/ag1/tools")[0]
    assert tool[4]["tool_type"] == "genie_space" and tool[4]["genie_space"] == {"id": "sp123"}
    assert out["_chat"]["agent_id"] == "ag1" and out["_chat"]["spec"]["access"] == [{"kind": "group", "principal": "g"}]


@case("if the chat version fails, the space is kept and a warning says what to do")
def _():
    f = Fake()
    f.fail[("POST", "/supervisor-agents")] = DbxError("name taken", 409)
    wire(f)
    out = genie.create(genie.clean(GOOD), WHO, "USER")
    assert out["space_id"] == "sp123" and out["chat"] is False and any("chat version" in w for w in out["warnings"])
    assert not f.of("DELETE")


@case("update keeps unmodelled content and sends the etag")
def _():
    f = Fake()
    f.current = {"etag": "E9", "serialized_space": json.dumps({"version": 2, "benchmarks": {"questions": [{"id": "z"}]}})}
    wire(f)
    genie.update_space("sp123", genie.clean(GOOD), "USER")
    body = f.of("PATCH", "/genie/spaces/sp123")[0][4]
    assert body["etag"] == "E9" and json.loads(body["serialized_space"])["benchmarks"] == {"questions": [{"id": "z"}]}


@case("edit and delete never fall back to the app identity, even for a scope refusal")
def _():
    f = Fake()
    f.fail[("GET", "/genie/spaces/")] = DbxError("token does not have required scopes: genie", 403)
    f.fail[("DELETE", "/genie/spaces/")] = DbxError("token does not have required scopes: genie", 403)
    wire(f, in_apps=True)
    for fn, args in ((genie.update_space, ("sp123", genie.clean(GOOD), "USER")), (genie.delete_space, ("sp123", "USER"))):
        try:
            fn(*args)
        except DbxError as exc:
            assert exc.status == 403
        else:
            raise AssertionError("did not raise")
    assert all(c[2] == "USER" for c in f.calls), "retried under another identity"


@case("create does fall back to the app, but only for a missing-scope refusal")
def _():
    f = Fake()
    wire(f, in_apps=True)

    def picky(method, path, token, **kw):
        if token == "USER" and method == "POST" and path.endswith("/genie/spaces"):
            raise DbxError("token does not have required scopes: genie", 403)
        return Fake.__call__(f, method, path, token, **kw)

    builder.call = picky
    out = genie.create(genie.clean({**GOOD, "chat": False}), WHO, "USER")
    assert out["acted_as"] == "the portal's service identity"


@case("invalid ids never reach the URL")
def _():
    for bad in ("../x", "a/b", "", "a b"):
        try:
            genie._check_id(bad)
        except DbxError:
            continue
        raise AssertionError("accepted " + repr(bad))


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
