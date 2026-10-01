"""Knowledge Assistant builder tests - fake Databricks, no workspace needed.

Run: python test_knowledge.py
"""
from __future__ import annotations

import access
import builder
import knowledge
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

    def __call__(self, method, path, token, **kw):
        self.calls.append((method, path, token, kw.get("params"), kw.get("json")))
        for (m, frag), exc in self.fail.items():
            if m == method and frag in path:
                raise exc
        if method == "POST" and path.endswith("/knowledge-assistants"):
            return {"knowledge_assistant_id": "ka1", "endpoint_name": ""}
        if method == "GET" and path.endswith("/knowledge-assistants/ka1"):
            return {"knowledge_assistant_id": "ka1", "endpoint_name": "ka-ka1-endpoint", "display_name": "hr-policy"}
        return {}

    def of(self, method, frag=""):
        return [c for c in self.calls if c[0] == method and frag in c[1]]


WHO = {"user_name": "a@x.io", "groups": ["admins"], "is_admin": True}
GOOD = {"display_name": "HR Policy Expert", "description": "Answers HR policy questions.",
        "instructions": "Be brief.",
        "sources": [{"volume": "main.hr.policies", "subfolder": "2026/final", "name": "Policy PDFs",
                     "description": "Leave, travel and conduct policies."}]}


def wire(f):
    builder.call = f
    knowledge.call = f
    access.call = f
    builder.app_token = lambda: "APP"
    knowledge.app_token = lambda: "APP"
    builder.in_apps = lambda: False
    builder._portal_sp = lambda t: ""


@case("friendly name becomes a letters-numbers-dashes Databricks name of 4-63 characters")
def _():
    assert knowledge.slug("HR Policy Expert") == "hr-policy-expert"
    for text in ("HR", "x", "A" * 200, "###"):
        s = knowledge.slug(text)
        assert 4 <= len(s) <= 63 and all(c.isalnum() or c == "-" for c in s), (text, s)
    assert knowledge.clean(GOOD)["api_name"] == "hr-policy-expert"


@case("an explicit Databricks name is validated; spaces and underscores are refused")
def _():
    assert knowledge.clean({**GOOD, "api_name": "hr-policies"})["api_name"] == "hr-policies"
    for bad in ("hr policies", "hr_policies", "ab", "x" * 64):
        try:
            knowledge.clean({**GOOD, "api_name": bad})
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(bad))


@case("a description is required, as are a name and at least one described folder")
def _():
    bads = [{**GOOD, "display_name": ""}, {**GOOD, "description": ""}, {**GOOD, "sources": []},
            {**GOOD, "sources": [{"volume": "main.hr.policies", "description": ""}]},
            {**GOOD, "sources": [{"volume": "not-a-volume", "description": "x"}]}]
    for b in bads:
        try:
            knowledge.clean(b)
        except DbxError as exc:
            assert exc.status == 400
        else:
            raise AssertionError("accepted " + repr(b)[:90])


@case("at most ten folders; duplicate source names are made unique")
def _():
    src = {"volume": "a.b.c", "description": "d"}
    try:
        knowledge.clean({**GOOD, "sources": [src] * 11})
    except DbxError:
        pass
    else:
        raise AssertionError("accepted 11")
    out = knowledge.clean({**GOOD, "sources": [src, src, src]})["sources"]
    assert len({s["name"] for s in out}) == 3


@case("subfolders cannot escape the volume")
def _():
    for sub in ("../other", "a/../../b", "a b"):
        try:
            knowledge.clean({**GOOD, "sources": [{"volume": "a.b.c", "description": "d", "subfolder": sub}]})
        except DbxError:
            continue
        raise AssertionError("accepted " + repr(sub))
    assert knowledge.volume_path("main.hr.policies", "2026/final") == "/Volumes/main/hr/policies/2026/final"


@case("create sends the documented fields, then each folder as a files source")
def _():
    f = Fake()
    wire(f)
    out = knowledge.create(knowledge.clean(GOOD), WHO, "USER")
    post = f.of("POST", "/knowledge-assistants")[0]
    assert post[4] == {"display_name": "hr-policy-expert", "description": "Answers HR policy questions.", "instructions": "Be brief."}
    src = f.of("POST", "/knowledge-sources")[0]
    assert src[1].endswith("/knowledge-assistants/ka1/knowledge-sources")
    assert src[4] == {"display_name": "policy-pdfs", "description": "Leave, travel and conduct policies.",
                      "source_type": "files", "files": {"path": "/Volumes/main/hr/policies/2026/final"}}
    assert out["ka_id"] == "ka1"


@case("create is all-or-nothing: a rejected folder deletes the new assistant and shows the Databricks message")
def _():
    f = Fake()
    f.fail[("POST", "/knowledge-sources")] = DbxError("unknown field files.path", 400)
    wire(f)
    try:
        knowledge.create(knowledge.clean(GOOD), WHO, "USER")
    except DbxError as exc:
        assert "nothing was created" in str(exc) and "unknown field files.path" in str(exc)
    else:
        raise AssertionError("did not raise")
    assert len(f.of("DELETE", "/knowledge-assistants/ka1")) == 1


@case("a missing sync endpoint is not an error")
def _():
    f = Fake()
    f.fail[("POST", ":sync")] = DbxError("404", 404)
    wire(f)
    out = knowledge.create(knowledge.clean(GOOD), WHO, "USER")
    assert out["ka_id"] == "ka1" and not f.of("DELETE")


@case("identity falls back to the app only for a missing-scope refusal, and edit/delete never do")
def _():
    f = Fake()
    wire(f)
    builder.in_apps = lambda: True

    def picky(method, path, token, **kw):
        if token == "USER" and method == "POST" and path.endswith("/knowledge-assistants"):
            raise DbxError("token does not have required scopes: knowledge-assistants", 403)
        return Fake.__call__(f, method, path, token, **kw)

    builder.call = picky
    out = knowledge.create(knowledge.clean(GOOD), WHO, "USER")
    assert out["acted_as"] == "the portal's service identity"

    g = Fake()
    g.fail[("PATCH", "/knowledge-assistants/ka1")] = DbxError("token does not have required scopes", 403)
    g.fail[("DELETE", "/knowledge-assistants/ka1")] = DbxError("token does not have required scopes", 403)
    wire(g)
    builder.in_apps = lambda: True
    spec = {"display_name": "X", "description": "d", "instructions": ""}
    for fn, args in ((knowledge.update_assistant, ("ka1", spec, "USER")), (knowledge.delete_assistant, ("ka1", "USER"))):
        try:
            fn(*args)
        except DbxError as exc:
            assert exc.status == 403
        else:
            raise AssertionError("did not raise")
    assert all(c[2] == "USER" for c in g.calls)


@case("provisioning waits for the endpoint, then hands over WITHOUT an agent_id tag; the friendly name becomes the tag")
def _():
    f = Fake()
    wire(f)
    knowledge.time.sleep = lambda s: None
    seen = {}
    builder.finish_provisioning = lambda agent_id, endpoint, spec, who: seen.update(agent_id=agent_id, endpoint=endpoint, spec=spec)
    knowledge.finish("ka1", knowledge.clean({**GOOD, "access": [{"kind": "group", "principal": "hr"}]}), WHO)
    assert seen["agent_id"] == "" and seen["endpoint"] == "ka-ka1-endpoint"
    assert seen["spec"]["display_name"] == "HR Policy Expert" and seen["spec"]["access"] == [{"kind": "group", "principal": "hr"}]


@case("invalid ids never reach the URL")
def _():
    for bad in ("../x", "a/b", "", "a b"):
        try:
            knowledge._check_id(bad)
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
            print("        " + type(exc).__name__ + ": " + str(exc)[:240])
            failed += 1
        else:
            print("  PASS  " + name)
            passed += 1
    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
