"""Dashboard tests - fake store and billing, no workspace needed.

Run: python test_dashboard.py
"""
from __future__ import annotations

import datetime as dt

import chats
import dashboard
import llm

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


class FakeStore:
    def __init__(self, answers=None):
        self.calls = []  # (sql, params)
        self.answers = answers or []

    def __call__(self, sql, params=None):
        self.calls.append((sql, params or []))
        for needle, rows in self.answers:
            if needle in sql:
                return rows
        return []


def setup(enabled=True, answers=None):
    chats.QUALIFIED = "`c`.`s`.`t`" if enabled else ""
    chats.ensure_table = lambda: None
    fs = FakeStore(answers)
    dashboard.store.run = fs
    return fs


@case("history off: says so and runs no SQL, rather than showing zeros")
def _():
    fs = setup(enabled=False)
    for r in (dashboard.activity("a@x", 30), dashboard.everyone(30), dashboard.costs(30, "tok")):
        assert r["enabled"] is False and "turned off" in r["note"]
    assert fs.calls == []


@case("period is clamped to 7, 30 or 90, and junk means 30")
def _():
    assert [dashboard.period(x) for x in (1, 7, 8, 30, 45, 90, 400, "x", None)] == [7, 7, 30, 30, 30, 90, 90, 30, 30]


@case("the person is a bound parameter, never part of the SQL text")
def _():
    fs = setup()
    evil = "x' OR 1=1; DROP TABLE t --"
    dashboard.activity(evil, 30)
    assert fs.calls
    for sql, params in fs.calls:
        assert evil not in sql and "DROP" not in sql
        assert "user_name = :u" in sql
        assert {"name": "u", "type": "STRING", "value": evil} in params


@case("the window length comes from the clamped number, not the request")
def _():
    fs = setup()
    dashboard.activity("a@x", "30; DROP TABLE t")
    assert all("INTERVAL 30 DAYS" in sql for sql, _ in fs.calls)


@case("one entry per day in the window, zero-filled, oldest first")
def _():
    today = dt.date.today()
    fs = setup(answers=[("GROUP BY 1", [[today.isoformat(), "4"]])])
    out = dashboard.activity("a@x", 7)
    days = out["per_day"]
    assert len(days) == 7 and days[-1] == {"day": today.isoformat(), "questions": 4}
    assert [d["day"] for d in days] == sorted(d["day"] for d in days)
    assert sum(d["questions"] for d in days) == 4


@case("totals and top assistants are parsed, with friendly names")
def _():
    setup(answers=[
        ("count(DISTINCT conversation_id), count(DISTINCT endpoint)", [["12", "5", "2", "3", "4", "2026-10-01T09:00:00Z"]]),
        ("GROUP BY endpoint", [["mas-1-endpoint", "9", "2026-10-01T09:00:00Z"], ["databricks-claude-haiku-4-5", "3", ""]]),
    ])
    out = dashboard.activity("a@x", 30, {"mas-1-endpoint": "Mid-Campaign Reporter"})
    assert (out["questions"], out["conversations"], out["assistants"], out["files_sent"], out["files_back"]) == (12, 5, 2, 3, 4)
    assert out["top_assistants"][0]["label"] == "Mid-Campaign Reporter"
    assert out["top_assistants"][1]["label"] != "databricks-claude-haiku-4-5"  # prettified


@case("the previous period is the same-length window just before this one")
def _():
    fs = setup(answers=[("created_at < current_timestamp()", [["7", "2"]])])
    out = dashboard.activity("a@x", 30)
    assert out["previous"] == {"questions": 7, "conversations": 2}
    prev_sql = [sql for sql, _ in fs.calls if "created_at <" in sql][0]
    assert "INTERVAL 60 DAYS" in prev_sql and "INTERVAL 30 DAYS" in prev_sql
    assert "user_name = :u" in prev_sql   # still only this person
    # the current window must not include the earlier one
    cur = [sql for sql, _ in fs.calls if "created_at <" not in sql and "INTERVAL 30 DAYS" in sql]
    assert cur


@case("the all-people table carries counts only: no message text or titles are selected")
def _():
    fs = setup(answers=[("GROUP BY user_name", [["a@x", "10", "3", "2", "2026-10-01T09:00:00Z"]])])
    out = dashboard.everyone(30)
    assert out["people"] == [{"user": "a@x", "questions": 10, "conversations": 3, "assistants": 2, "last_active": "2026-10-01T09:00:00Z"}]
    sql = fs.calls[0][0].lower()
    final = sql.split(") select ", 1)[1]  # the SELECT after the CTE
    assert "content" not in final and "min_by" not in final and "meta" not in final


@case("estimated cost: each endpoint's billed cost is shared by questions; unused endpoints stay unattributed")
def _():
    setup(answers=[("GROUP BY user_name, endpoint", [
        ["a@x", "ep1", "3"], ["b@x", "ep1", "1"],   # ep1 $8 -> a 6, b 2
        ["a@x", "ep2", "5"],                        # ep2 $2 -> a 2
    ])])
    llm.spend = lambda tok, days: {"available": True, "total_usd": 13.0, "lines": [
        {"raw": "ep1", "usd": 8.0}, {"raw": "ep2", "usd": 2.0}, {"raw": "ep-nobody-used", "usd": 3.0}, {"raw": "free", "usd": None}]}
    out = dashboard.costs(30, "tok")
    rows = {r["user"]: r for r in out["rows"]}
    assert rows["a@x"]["est_usd"] == 8.0 and rows["b@x"]["est_usd"] == 2.0
    assert out["unattributed_usd"] == 3.0 and out["total_usd"] == 13.0
    assert abs(sum(r["est_usd"] for r in out["rows"]) + out["unattributed_usd"] - 13.0) < 0.01
    assert out["rows"][0]["user"] == "a@x"  # biggest first


@case("estimated cost: billing unreadable degrades to a note, not an error")
def _():
    setup()
    llm.spend = lambda tok, days: {"available": False, "note": "no access to system.billing"}
    out = dashboard.costs(30, "tok")
    assert out["available"] is False and "system.billing" in out["note"] and out["rows"] == []


@case("insights and org: history off says so and runs no SQL")
def _():
    fs = setup(enabled=False)
    a, b = dashboard.insights("a@x", 30), dashboard.org(30)
    assert a["enabled"] is False and a["files"] == [] and a["hours"] == []
    assert b["enabled"] is False and b["per_day"] == []
    assert fs.calls == []


@case("insights: only this person, as a bound parameter, in the clamped window")
def _():
    fs = setup()
    evil = "x' OR 1=1 --"
    dashboard.insights(evil, 90)
    assert fs.calls
    for sql, params in fs.calls:
        assert evil not in sql and "DROP" not in sql
        assert "user_name = :u" in sql and "INTERVAL 90 DAYS" in sql
        assert {"name": "u", "type": "STRING", "value": evil} in params


@case("insights: files sent and received are read from message metadata; junk rows are skipped")
def _():
    setup(answers=[("meta LIKE", [
        ["assistant", "ep1", "c1", '{"attachments": [{"name": "Report.pptx", "path": "/Volumes/a/b/c/out/Report.pptx"}, {"name": "x"}]}', "2026-10-01T09:00:00Z"],
        ["user", "ep1", "c1", '{"files": ["/Volumes/a/b/c/uploads/in.xlsx", ""]}', "2026-10-01T08:59:00Z"],
        ["assistant", "ep2", "c2", "not json", "2026-09-30T09:00:00Z"],
    ]), ("HH:00:00", [["2026-10-01T09:00:00Z", "3"], [None, "1"]])])
    out = dashboard.insights("a@x", 30, {"ep1": "Reporter"})
    got = [(f["direction"], f["name"], f["path"], f["label"]) for f in out["files"]]
    assert got == [
        ("received", "Report.pptx", "/Volumes/a/b/c/out/Report.pptx", "Reporter"),
        ("sent", "in.xlsx", "", "Reporter"),
    ], got
    assert out["hours"] == [{"hour": "2026-10-01T09:00:00Z", "questions": 3}]


@case("insights: an agent echoing your own upload is not a received file; repeats of one path collapse")
def _():
    setup(answers=[("meta LIKE", [
        ["assistant", "ep1", "c1", '{"attachments": [{"name": "in.xlsx", "path": "/Volumes/a/b/c/uploads/in.xlsx"}, {"name": "out.pptx", "path": "/V/out.pptx"}]}', "2026-10-01T09:01:00Z"],
        ["user", "ep1", "c1", '{"files": ["in.xlsx"]}', "2026-10-01T09:00:00Z"],
        ["assistant", "ep1", "c0", '{"attachments": [{"name": "out.pptx", "path": "/V/out.pptx"}]}', "2026-09-30T09:00:00Z"],
    ])])
    got = [(f["direction"], f["name"], f["conversation_id"]) for f in dashboard.insights("a@x", 30)["files"]]
    assert got == [("received", "out.pptx", "c1"), ("sent", "in.xlsx", "c1")], got


@case("org: counts only - no message text, titles or metadata are selected")
def _():
    today = dt.date.today().isoformat()
    fs = setup(answers=[
        ("GROUP BY endpoint", [["ep1", "9", "3", "2026-10-01T09:00:00Z"]]),
        ("GROUP BY 1", [[today, "5", "2"]]),
        ("min(created_at)", [["4"]]),
        ("created_at < current_timestamp()", [["2", "6"]]),
        ("count(DISTINCT endpoint)", [["3", "12", "7", "2"]]),
    ])
    out = dashboard.org(7, {"ep1": "Reporter"})
    assert (out["people"], out["questions"], out["conversations"], out["assistants"], out["new_people"]) == (3, 12, 7, 2, 4)
    assert out["previous"] == {"people": 2, "questions": 6}
    assert len(out["per_day"]) == 7 and out["per_day"][-1] == {"day": today, "questions": 5, "people": 2}
    assert out["assistants_used"][0] == {"name": "ep1", "label": "Reporter", "questions": 9, "people": 3, "last_used": "2026-10-01T09:00:00Z"}
    for sql, _ in fs.calls:
        final = sql.lower().split(") select ", 1)[-1]
        assert "content" not in final and "meta" not in final and "min_by" not in final


# ----------------------------------------------------------------- routes ---

def _client(is_admin: bool, user="me@x.io"):
    import app as portal
    from fastapi.testclient import TestClient

    portal.user_token = lambda f: "T"
    portal.access.identity = lambda tok: {"user_name": user, "groups": ["admins"] if is_admin else [], "is_admin": is_admin}
    portal.app_token = lambda: "APP"
    portal.access.all_agents = lambda tok, meta_tok="": []
    seen = {}
    dashboard.activity = lambda u, d, n=None: seen.setdefault("act", []).append((u, d)) or {"enabled": True}
    dashboard.everyone = lambda d, n=None: {"enabled": True, "people": []}
    dashboard.costs = lambda d, tok, n=None: {"enabled": True, "rows": []}
    dashboard.insights = lambda u, d, n=None: seen.setdefault("ins", []).append((u, d)) or {"enabled": True}
    dashboard.org = lambda d, n=None: {"enabled": True}
    return TestClient(portal.app), seen


@case("/api/dashboard/me always uses the caller's own name; a user parameter is ignored")
def _():
    c, seen = _client(is_admin=False, user="me@x.io")
    assert c.get("/api/dashboard/me?user=boss@x.io&days=7").status_code == 200
    assert seen["act"] == [("me@x.io", 7)]


@case("/api/dashboard/me/insights always uses the caller's own name; a user parameter is ignored")
def _():
    c, seen = _client(is_admin=False, user="me@x.io")
    assert c.get("/api/dashboard/me/insights?user=boss@x.io&days=90").status_code == 200
    assert seen["ins"] == [("me@x.io", 90)]


@case("non-admins are refused on every admin dashboard route")
def _():
    c, _ = _client(is_admin=False)
    for p in ("/api/admin/dashboard/people", "/api/admin/dashboard/person?user=a@x", "/api/admin/dashboard/costs",
              "/api/admin/dashboard/overview"):
        assert c.get(p).status_code == 403, p


@case("admins can look up a person; an empty name is rejected")
def _():
    c, seen = _client(is_admin=True)
    assert c.get("/api/admin/dashboard/person?user=asha@x.io&days=30").status_code == 200
    assert seen["act"][-1] == ("asha@x.io", 30)
    assert c.get("/api/admin/dashboard/person?user=%20").status_code == 400


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
