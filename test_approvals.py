"""Human approval of tool calls, and downloads without per-agent setup - no network.

Run: python test_approvals.py

A read-only tool runs by itself; a tool that changes something waits for the person,
who approves or declines it in the chat (toolpolicy, chat.resume, /api/chat/decide).
Files an agent names in a reply carry a signed permit for that person and assistant, so
they download without an admin declaring the agent's folder (signer, /api/download).
"""
from __future__ import annotations

import json
import time

import httpx

import chat
import signer
import toolpolicy

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


def msg(text):
    return {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}


def req(rid, name):
    return {"type": "mcp_approval_request", "id": rid, "name": name, "arguments": json.dumps({"plan": "MP-1"}), "server_label": "planner-mcp"}


DECLARED = {"get_plan": {"read_only": True, "description": "Reads a plan."},
            "finalize_media_plan": {"read_only": False, "description": "Writes the final plan files."}}


class Endpoint:
    """Plays an agent: looks up a plan (read-only), then wants to finalise it (changes things)."""

    def __init__(self):
        self.sent = []

    def __call__(self, endpoint, payload, tok):
        self.sent.append(payload)
        answered = [i for i in payload.get("input") or [] if isinstance(i, dict) and i.get("type") == "mcp_approval_response"]
        ids = {a["approval_request_id"]: a["approve"] for a in answered}
        if "R2" in ids:
            return httpx.Response(200, json={"output": [msg("Finalised: /Volumes/c/s/out/MP-1_v1.xlsx" if ids["R2"] else "OK, I did not finalise it.")]})
        if "R1" in ids:
            return httpx.Response(200, json={"output": [msg("Plan read. Finalising now."), req("R2", "finalize_media_plan")]})
        return httpx.Response(200, json={"output": [msg("Let me read it."), req("R1", "get_plan")]})


def wire(ep, declared=DECLARED):
    chat._post = ep
    toolpolicy.tools_of = lambda server, tok: declared


def ask(mode="changes"):
    return chat.ask("e", "agent/v1/responses", [{"role": "user", "content": "finalise MP-1"}], "TOK",
                    ask_person=lambda r: toolpolicy.needs_person(r, mode, "TOK"))


@case("a read-only tool runs by itself; one that changes something waits, and nothing is answered for it")
def _():
    ep = Endpoint()
    wire(ep)
    out = ask()
    assert out["pause"]["asked"] == ["R2"], out
    assert "get_plan" in out["tools"] and "finalize_media_plan" not in out["tools"], out["tools"]
    assert "Finalising now" in out["reply"]
    assert len(ep.sent) == 2  # the lookup was approved by itself; the finalise was never answered


@case("approved: the same answer carries on and the tool runs; declined: the agent is told no")
def _():
    for yes, says in ((True, "Finalised"), (False, "did not finalise")):
        ep = Endpoint()
        wire(ep)
        pause = ask()["pause"]
        out = chat.resume("e", pause, {"R2": yes}, "TOK", ask_person=lambda r: toolpolicy.needs_person(r, "changes", "TOK"))
        assert says in out["reply"] and "pause" not in out, out
        last = [i for i in ep.sent[-1]["input"] if i.get("type") == "mcp_approval_response"]
        want = {"type": "mcp_approval_response", "approval_request_id": "R2", "approve": yes}
        if not yes:  # a decline says so, or the agent takes it for a format error and asks again (seen live)
            want["reason"] = chat.adapters.DECLINED
        assert last[-1] == want, last
        assert ("finalize_media_plan" in out["tools"]) is yes


@case("a request nobody decided is declined, never quietly approved")
def _():
    ep = Endpoint()
    wire(ep)
    pause = ask()["pause"]
    chat.resume("e", pause, {}, "TOK")
    last = [i for i in ep.sent[-1]["input"] if i.get("type") == "mcp_approval_response"]
    assert last[-1]["approve"] is False


@case("per-assistant setting: auto never asks (the old behaviour), all asks for every tool")
def _():
    ep = Endpoint()
    wire(ep)
    out = ask("auto")
    assert "pause" not in out and "Finalised" in out["reply"]
    ep = Endpoint()
    wire(ep)
    assert ask("all")["pause"]["asked"] == ["R1"]
    assert toolpolicy.mode_of("AUTO") == "auto" and toolpolicy.mode_of("") == "changes" and toolpolicy.mode_of("nonsense") == "changes"


@case("a tool whose declaration cannot be read is asked about, not run unseen")
def _():
    ep = Endpoint()
    wire(ep, declared=None)
    assert ask()["pause"]["asked"] == ["R1"]


@case("no policy (the designer's tests, older callers): every request is approved as before")
def _():
    ep = Endpoint()
    wire(ep)
    out = chat.ask("e", "agent/v1/responses", [{"role": "user", "content": "x"}], "TOK")
    assert "Finalised" in out["reply"] and "pause" not in out


@case("permits: read back intact, refused when changed or expired")
def _():
    t = signer.permit({"e": "a", "p": "/Volumes/c/s/v/f.xlsx", "u": "me"}, 60)
    assert signer.read(t)["p"] == "/Volumes/c/s/v/f.xlsx"
    raw, sig = t.split(".")
    assert signer.read(raw + "x." + sig) is None and signer.read(raw + "." + sig[:-2] + "AA") is None
    assert signer.read(signer.permit({"e": "a"}, -5)) is None and signer.read("") is None and signer.read("junk") is None
    state = {"e": "a", "u": "me", "pause": {"asked": ["R2"]}}
    assert signer.check(state, signer.mac(state)) and not signer.check({**state, "u": "you"}, signer.mac(state))


# --- the routes ------------------------------------------------------------------

AGENT = {"name": "mas-1", "task": "agent/v1/responses", "display_name": "Planner", "output_volume": "", "tool_approval": "",
         "ready": True}


def client(user="me@x.io"):
    from fastapi.testclient import TestClient

    import app as portal

    portal.user_token = lambda f: "T"
    portal.app_token = lambda: "APP"
    portal.access.identity = lambda tok: {"user_name": user, "groups": [], "is_admin": False}
    portal.access.visible_agents = lambda who, app_tok, tok="": [AGENT]
    portal.chats.enabled = lambda: False
    return portal, TestClient(portal.app, raise_server_exceptions=False)


@case("the chat route hands back a signed decision; the decide route checks it, records it, and carries on")
def _():
    ep = Endpoint()
    wire(ep)
    _, c = client()
    r = c.post("/api/chat", json={"endpoint": "mas-1", "history": [{"role": "user", "content": "finalise MP-1"}]})
    assert r.status_code == 200, r.text
    a = r.json()["approval"]
    assert [i["tool"] for i in a["items"]] == ["finalize_media_plan"] and a["items"][0]["description"] == "Writes the final plan files."
    assert a["items"][0]["arguments"] == {"plan": "MP-1"}
    body = {"endpoint": "mas-1", "history": [{"role": "user", "content": "finalise MP-1"}], "approval": a, "decisions": {"R2": True}}
    tampered = json.loads(json.dumps(body))
    tampered["approval"]["state"]["pause"]["asked"] = []
    assert c.post("/api/chat/decide", json=tampered).status_code == 400
    assert c.post("/api/chat/decide", json={**body, "endpoint": "mas-other"}).status_code == 400
    r = c.post("/api/chat/decide", json=body)
    assert r.status_code == 200 and "Finalised" in r.json()["reply"], r.text
    f = r.json()["attachments"][0]
    assert f["path"] == "/Volumes/c/s/out/MP-1_v1.xlsx" and f["sig"]
    _, other = client("someone@else.io")  # a decision is only good for the person it was made for
    assert other.post("/api/chat/decide", json=body).status_code == 400


@case("a file the agent named downloads with its permit, without the agent's folder being declared")
def _():
    portal, c = client()
    portal.filestore.download = lambda path, tok: b"xlsx-bytes"
    ok = signer.permit({"e": "mas-1", "p": "/Volumes/c/s/out/MP-1_v1.xlsx", "u": "me@x.io"}, 60)
    r = c.get("/api/download", params={"endpoint": "mas-1", "path": "/Volumes/c/s/out/MP-1_v1.xlsx", "sig": ok})
    assert r.status_code == 200 and r.content == b"xlsx-bytes", r.text
    # another file, another person's permit, or none: back to the declared-folder rule (none here)
    assert c.get("/api/download", params={"endpoint": "mas-1", "path": "/Volumes/c/s/out/other.xlsx", "sig": ok}).status_code == 400
    assert c.get("/api/download", params={"endpoint": "mas-1", "path": "/Volumes/c/s/out/MP-1_v1.xlsx"}).status_code == 400
    theirs = signer.permit({"e": "mas-1", "p": "/Volumes/c/s/out/MP-1_v1.xlsx", "u": "someone@else.io"}, 60)
    assert c.get("/api/download", params={"endpoint": "mas-1", "path": "/Volumes/c/s/out/MP-1_v1.xlsx", "sig": theirs}).status_code == 400
    # a path that climbs out of its folder is never given a permit
    assert "sig" not in portal._sign_files([{"name": "x", "path": "/Volumes/c/s/out/../../secret/x"}], "mas-1", "me@x.io")[0]


def main() -> int:
    passed = failed = 0
    for name, fn in CASES:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - test harness
            print("  FAIL  " + name)
            print("        " + type(exc).__name__ + ": " + str(exc)[:300])
            failed += 1
        else:
            print("  PASS  " + name)
            passed += 1
    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    time.sleep(0)
    raise SystemExit(main())
