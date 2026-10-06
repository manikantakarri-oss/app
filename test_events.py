"""Activity log and agent health tests - no workspace needed.

Run: python test_events.py
"""
from __future__ import annotations

import events

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


def fresh():
    """Memory-only storage, empty, no session de-duplication carried over."""
    events.QUALIFIED = ""
    events._memory.clear()
    events._last_session.clear()


def act(action, status_code=200, ms=100, **fields):
    rec = events.begin()
    events.note(action=action, **fields)
    if status_code >= 400 and "error" in fields:
        events.failed(fields["error"], status_code)
    events.finish(rec, status_code, ms, "")
    return list(events._memory)[-1] if events._memory else None


@case("only marked actions are recorded; plain listing requests are not")
def _():
    fresh()
    rec = events.begin()
    events.note(actor="a@x")  # every request names its caller, but did nothing
    events.finish(rec, 200, 5, "")
    assert len(events._memory) == 0
    act("asked", actor="a@x", target="ep1")
    assert len(events._memory) == 1


@case("a question is recorded without its text: only assistant, outcome and timing")
def _():
    fresh()
    row = act("asked", actor="a@x", target="ep1", label="Reporter", detail={"files": 1})
    assert row["action"] == "asked" and row["category"] == "questions" and row["status"] == "ok"
    assert row["target"] == "ep1" and row["label"] == "Reporter" and row["ms"] == 100
    assert set(row) == set(events.COLUMNS), "no column may carry the question or the answer"


@case("a failed question keeps the reason Databricks gave, and is classified")
def _():
    fresh()
    row = act("asked", 403, actor="a@x", target="ep1", error="PERMISSION_DENIED: User does not have CAN_QUERY")
    assert row["status"] == "error" and row["http_status"] == 403
    assert row["error_kind"] == "no_access" and "PERMISSION_DENIED" in row["error"]


@case("error kinds are plain-English and actionable")
def _():
    c = events.classify
    assert c("User does not have USE SCHEMA on schema main.sales") == "data_access"
    assert c("could not reach the agent endpoint: timed out") == "timeout"
    assert c("Endpoint is not ready: scaling from zero") == "not_ready"
    assert c("429 REQUEST_LIMIT_EXCEEDED") == "rate_limit"
    assert c("something odd", 502) == "agent_error"
    assert c("something odd", 403) == "no_access"
    assert c("x", 200, "tool_error") == "tool_error"
    assert c("nothing recognisable", 418) == "other"


@case("a reply that arrived fine but had a failed tool inside is caught")
def _():
    reply = ("I apologise.\nCalled get_mid_campaign_ppt_report -> Error calling tool 'get_mid_campaign_ppt_report': "
             "❌ Could not resolve an uploaded .xlsx workbook.")
    got = events.tool_failure(reply)
    assert got.startswith("get_mid_campaign_ppt_report:") and "Could not resolve" in got
    assert events.tool_failure("Called weather -> Sunny, 24 degrees") == ""
    assert events.tool_failure("") == ""


@case("opening the portal is recorded once per person per half hour, not on every refresh")
def _():
    fresh()
    for _ in range(5):
        act("opened_portal", actor="a@x")
    act("opened_portal", actor="b@x")
    assert [r["actor"] for r in events._memory] == ["a@x", "b@x"]


@case("activity filters by category, failures and person; counts cover the whole window")
def _():
    fresh()
    act("asked", actor="asha@x", target="ep1")
    act("asked", 502, actor="asha@x", target="ep1", error="boom")
    act("uploaded", actor="ravi@x", target="ep1", detail={"name": "in.xlsx"})
    act("granted", actor="admin@x", target="ep1", detail={"principal": "finance"})
    out = events.activity(7)
    assert out["total"] == 4 and out["people"] == 3 and out["failed"] == 1
    assert out["categories"] == {"questions": 2, "files": 1, "access": 1}
    assert [e["action"] for e in events.activity(7, category="files")["events"]] == ["uploaded"]
    assert [e["status"] for e in events.activity(7, status="failed")["events"]] == ["error"]
    assert {e["actor"] for e in events.activity(7, actor="ASHA")["events"]} == {"asha@x"}
    assert out["events"][0]["action"] == "granted", "newest first"


@case("agent health: failure rate, tool errors, timing and the last problem per assistant")
def _():
    fresh()
    for ms in (1000, 2000, 3000):
        act("asked", ms=ms, actor="a@x", target="good", label="Good one")
    act("asked", actor="a@x", target="bad", label="Bad one")
    act("asked", 502, actor="b@x", target="bad", label="Bad one", error="agent crashed")
    rec = events.begin()
    events.note(action="asked", actor="b@x", target="bad", label="Bad one", status="tool_error", error="ppt: Error calling tool")
    events.finish(rec, 200, 900, "")
    h = events.health(7)
    assert h["questions"] == 6 and h["failed"] == 2 and h["tool_errors"] == 1
    bad, good = h["agents"][0], h["agents"][1]
    assert bad["endpoint"] == "bad", "worst first"
    assert bad["failed"] == 2 and bad["tool_errors"] == 1 and abs(bad["failure_rate"] - 2 / 3) < 1e-3
    assert bad["last_problem"]["kind"] == "tool_error", "newest problem wins"
    assert bad["people"] == 2
    assert good["failure_rate"] == 0 and good["avg_ms"] == 2000 and good["last_problem"] is None
    assert {k["kind"] for k in h["kinds"]} == {"tool_error", "agent_error"}


@case("health: a refused or unknown assistant name is a cause, never a row in the assistants table")
def _():
    fresh()
    act("asked", actor="a@x", target="real", label="Real one", detail={"known": True})
    act("asked", 403, actor="a@x", target="no-such-endpoint", error="You do not have access to that agent.")
    h = events.health(7)
    assert [a["endpoint"] for a in h["agents"]] == ["real"]
    assert h["questions"] == 2 and h["failed"] == 1 and h["kinds"][0]["kind"] == "no_access"
    assert h["recent"][0]["target"] == "no-such-endpoint"


@case("tables: a refused CREATE on an existing table is fine; an unreachable table says which grants fix it")
def _():
    import store
    from dbx import DbxError

    def runner(answers):
        seen = []

        def run(sql, params=None):
            seen.append(sql.split()[0])
            for start, outcome in answers:
                if sql.startswith(start):
                    if isinstance(outcome, Exception):
                        raise outcome
                    return outcome
            return []
        return run, seen

    denied = DbxError("PERMISSION_DENIED: User does not have CREATE TABLE on Schema 'c.s'.", 403)
    # Exists: CREATE refused, SELECT works -> no error, clean-up still attempted.
    run, seen = runner([("CREATE SCHEMA", denied), ("CREATE TABLE", denied), ("SELECT 1", [[1]])])
    store.ensure_table("`c`.`s`.`t`", "CREATE TABLE IF NOT EXISTS `c`.`s`.`t` (a INT)", "DELETE FROM `c`.`s`.`t`", run)
    assert seen == ["CREATE", "CREATE", "SELECT", "DELETE"], seen
    # Unreachable: a 403 whose message names the grants, not a raw Databricks error.
    run, _ = runner([("CREATE", denied), ("SELECT 1", DbxError("PERMISSION_DENIED: no SELECT", 403))])
    try:
        store.ensure_table("`c`.`s`.`t`", "CREATE TABLE IF NOT EXISTS `c`.`s`.`t` (a INT)", "", run)
        raise AssertionError("expected an error")
    except DbxError as exc:
        assert exc.status == 403 and "GRANT USE CATALOG ON CATALOG c" in str(exc) and "CAN_USE on a SQL warehouse" in str(exc)
    # Anything that is not a permission problem still surfaces as it was.
    run, _ = runner([("CREATE TABLE", DbxError("warehouse is stopped", 502))])
    try:
        store.ensure_table("`c`.`s`.`t`", "CREATE TABLE IF NOT EXISTS `c`.`s`.`t` (a INT)", "", run)
        raise AssertionError("expected an error")
    except DbxError as exc:
        assert exc.status == 502 and "stopped" in str(exc)


@case("durable write: every value is a bound parameter; the table name is the only SQL text")
def _():
    calls = []
    events._run = lambda sql, params=None: calls.append((sql, params or [])) or []
    events.QUALIFIED = "`c`.`s`.`portal_events`"
    events._ready = True
    evil = "x'); DROP TABLE t; --"
    events._write([{"at": "2026-10-01 10:00:00", "actor": evil, "action": "asked", "category": "questions", "target": evil,
                    "label": "", "status": "ok", "http_status": 200, "ms": 5, "error_kind": "", "error": "", "detail": "{}"}])
    sql, params = calls[-1]
    assert evil not in sql and "DROP" not in sql and sql.startswith("INSERT INTO `c`.`s`.`portal_events` VALUES")
    assert {"name": "actor0", "type": "STRING", "value": evil} in params
    events.QUALIFIED = ""


# ----------------------------------------------------------------- routes ---

def _client(is_admin: bool):
    import app as portal
    from fastapi.testclient import TestClient

    portal.user_token = lambda f: "T"
    portal.access.identity = lambda tok: {"user_name": "me@x.io", "groups": [], "is_admin": is_admin}
    portal.app_token = lambda: "APP"
    return portal, TestClient(portal.app)


@case("non-admins cannot read activity or agent health")
def _():
    _, c = _client(is_admin=False)
    for p in ("/api/admin/activity", "/api/admin/agent-health"):
        assert c.get(p).status_code == 403, p


@case("a chat through the real route is recorded with its outcome and the caller from the token")
def _():
    fresh()
    portal, c = _client(is_admin=False)
    portal.access.visible_agents = lambda who, app_tok, user_tok="": [
        {"name": "ep1", "display_name": "Reporter", "task": "agent/v1/responses", "output_volume": ""}]
    portal.chat.ask = lambda *a, **k: {"reply": "Called report -> Error calling tool 'report': ❌ bad file", "tools": ["report"], "citations": [], "attachments": []}
    r = c.post("/api/chat", json={"endpoint": "ep1", "history": [{"role": "user", "content": "SECRET QUESTION"}]})
    assert r.status_code == 200
    row = list(events._memory)[-1]
    assert row["action"] == "asked" and row["actor"] == "me@x.io" and row["label"] == "Reporter"
    assert row["status"] == "tool_error" and row["error_kind"] == "tool_error"
    assert "SECRET QUESTION" not in repr(row), "the question must never be recorded"

    r = c.post("/api/chat", json={"endpoint": "nope", "history": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 403
    row = list(events._memory)[-1]
    assert row["status"] == "error" and row["error_kind"] == "no_access" and "do not have access" in row["error"]


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
