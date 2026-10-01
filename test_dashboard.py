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
    return TestClient(portal.app), seen


@case("/api/dashboard/me always uses the caller's own name; a user parameter is ignored")
def _():
    c, seen = _client(is_admin=False, user="me@x.io")
    assert c.get("/api/dashboard/me?user=boss@x.io&days=7").status_code == 200
    assert seen["act"] == [("me@x.io", 7)]


@case("non-admins are refused on every admin dashboard route")
def _():
    c, _ = _client(is_admin=False)
    for p in ("/api/admin/dashboard/people", "/api/admin/dashboard/person?user=a@x", "/api/admin/dashboard/costs"):
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
