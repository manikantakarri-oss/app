"""Agent invocation.

Always called with the signed-in user's OBO token, so the serving-endpoint ACL
and Unity Catalog decide what actually runs.

Two hazards this layer exists to absorb:

* **Agents disagree on the wire format.** `adapters` picks a shape from the
  endpoint's task, and if the endpoint rejects it, the rejection is read and the
  other shape is tried once, then remembered. That is what lets the portal front
  an agent type nobody anticipated.
* **An agent can fail with HTTP 200.** A Genie-backed agent returns an SSE body
  whose first event is `event: error`. Status-code checks alone yield a blank
  reply, so the stream is parsed and errors are raised explicitly.
"""
from __future__ import annotations

import json

import httpx

import adapters
from dbx import DbxError, host


def _detail(body: str, fallback: str) -> str:
    try:
        j = json.loads(body)
    except json.JSONDecodeError:
        return fallback
    if isinstance(j, dict):
        return str(j.get("message") or j.get("error_code") or fallback)
    return fallback


def _post(endpoint: str, payload: dict, user_tok: str) -> httpx.Response:
    try:
        return httpx.post(
            host() + "/serving-endpoints/" + endpoint + "/invocations",
            headers={"Authorization": "Bearer " + user_tok, "Content-Type": "application/json"},
            json=payload,
            timeout=600,
        )
    except httpx.RequestError as exc:
        raise DbxError("could not reach the agent endpoint: " + str(exc), 504)


def _read(resp: httpx.Response) -> dict:
    """Turn a 2xx response into a normalised reply, handling JSON and SSE."""
    body = resp.text or ""
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype or body.lstrip().startswith(("event:", "data:")):
        try:
            return adapters.parse_sse(body)
        except adapters.AgentStreamError as exc:
            raise DbxError(str(exc), 502)
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        # Some custom agents return bare text.
        if body.strip():
            return {"reply": body.strip(), "tools": [], "citations": [], "attachments": []}
        raise DbxError("the agent returned an empty response", 502)
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        raise DbxError(str(err.get("message") if isinstance(err, dict) else err), 502)
    return adapters.parse(data)


def ask(endpoint: str, task: str, history: list, user_tok: str, files: list | None = None) -> dict:
    """Send a conversation to an agent and return a normalised reply."""
    history = list(history or [])
    if files:
        # Agents cannot see a browser upload; they read the volume. Naming the
        # paths in the turn is what lets a file-driven agent find its input.
        note = "Uploaded file" + ("s" if len(files) > 1 else "") + ": " + ", ".join(files)
        if history and history[-1].get("role") == "user":
            history[-1] = dict(history[-1], content=(history[-1]["content"] + "\n\n" + note).strip())
        else:
            history.append({"role": "user", "content": note})

    payload, field = adapters.build(task, endpoint, history)
    if not (payload.get("input") or payload.get("messages")):
        raise DbxError("nothing to send", 400)

    resp = _post(endpoint, payload, user_tok)

    # Wrong request field? The endpoint says so in the 400. Switch once.
    if resp.status_code >= 400 and adapters.wrong_field(resp.status_code, resp.text):
        alt = adapters.other_field(field)
        payload = {alt: payload[field]}
        resp = _post(endpoint, payload, user_tok)
        if resp.status_code < 400:
            adapters.learn(endpoint, alt)
    elif resp.status_code < 400:
        adapters.learn(endpoint, field)

    if resp.status_code >= 400:
        detail = _detail(resp.text, resp.text[:400])
        if resp.status_code in (401, 403):
            raise DbxError(
                "Databricks refused this call under your identity. You may have lost "
                "CAN_QUERY on this agent, or it reads data you lack access to. " + detail,
                403,
            )
        raise DbxError(detail, resp.status_code)

    out = _read(resp)
    if not out["reply"] and not out["attachments"]:
        raise DbxError("the agent completed but returned no text", 502)
    return out
