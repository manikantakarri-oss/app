"""Connections: the credentials a tool needs (a Google Drive key, an API token),
entered by an admin and kept in the workspace's secret store.

The rule this module exists to keep: **a credential value never reaches an AI
model.** The designer model may only *request* a connection by name, with a
label and a sentence on how to get it. The admin enters the value in a
dedicated form that posts here, never into the conversation; it is written to
the secret scope (`mcps.SECRET_SCOPE`, `agent-portal` by default) and nothing
is returned but "set". The model then sees `connected: true`, nothing more. A
tool's app gets the value as a Databricks app resource of the same name
(`mcps._resources`), so it goes from Databricks to the tool directly.

Never logged: values are not in any log line, event or error message.

Identity: the admin's own token first. A Databricks Apps user token usually
lacks the `secrets` scope, so on a refusal the portal's own identity writes it
(the route is admin-only, and the Portal Deployer gives the portal MANAGE on the
scope). If the scope does not exist yet it is created.

Names: lowercase letters, digits and dashes, as Databricks secret keys and app
resource names allow. A name already in use is never overwritten silently: the
admin must ask to replace it.
"""
from __future__ import annotations

import json
import logging
import re

import mcps
from dbx import DbxError, app_token, call

log = logging.getLogger("portal.connections")

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$")
KINDS = ("key_file", "secret_text")
MAX_VALUE = 64 * 1024


def check_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not NAME.match(name):
        raise DbxError("A connection name is 3 to 42 lowercase letters, digits and dashes, like google-drive-key.", 400)
    return name


def status(names: list[str], tok: str = "") -> dict:
    """{name: True/False} for each name: set in the secret store or not. Names only."""
    have = mcps.secrets_present(tok)
    return {n: n in have for n in names if isinstance(n, str) and NAME.match(n)}


def _as(method: str, path: str, tok: str, **kw):
    """The admin's token, then the portal's identity on a refusal (route is admin-only)."""
    try:
        return call(method, path, tok, quiet=True, **kw)
    except DbxError as exc:
        if exc.status not in (401, 403):
            raise
    return call(method, path, app_token(), quiet=True, **kw)


def _ensure_scope(tok: str) -> None:
    scopes = {s.get("name") for s in (_as("GET", "/api/2.0/secrets/scopes/list", tok) or {}).get("scopes") or []}
    if mcps.SECRET_SCOPE not in scopes:
        try:
            _as("POST", "/api/2.0/secrets/scopes/create", tok, json={"scope": mcps.SECRET_SCOPE})
        except DbxError as exc:
            if "already exists" not in str(exc).lower():
                raise


def save(name: str, value: str, kind: str, tok: str, replace: bool = False) -> dict:
    """Store a credential. Returns {name, set: True}. The value is never echoed or logged."""
    name = check_name(name)
    if kind not in KINDS:
        kind = "secret_text"
    if not isinstance(value, str) or not value.strip():
        raise DbxError("Enter the value to save.", 400)
    if len(value.encode("utf-8")) > MAX_VALUE:
        raise DbxError("That is too large for a connection setting (64 KB at most).", 413)
    if kind == "key_file" and value.lstrip().startswith("{"):
        try:
            json.loads(value)
        except ValueError:
            raise DbxError("That key file is not valid JSON. Upload the file exactly as you downloaded it.", 400) from None
    if not replace and name in mcps.secrets_present(tok):
        raise DbxError("A connection called %s is already saved. Choose Replace to change it." % name, 409)
    _ensure_scope(tok)
    try:
        _as("POST", "/api/2.0/secrets/put", tok, json={"scope": mcps.SECRET_SCOPE, "key": name, "string_value": value})
    except DbxError as exc:
        # Databricks' message never contains the value; keep it short anyway.
        raise DbxError("The connection could not be saved: %s" % str(exc)[:200], exc.status) from None
    mcps._secrets_seen = None  # the next look sees it at once
    log.info("connection %s saved (%s)%s", name, kind, " (replaced)" if replace else "")
    return {"name": name, "set": True}


def clean_requests(raw) -> list[dict]:
    """What a model asked the admin to connect: names and plain words only."""
    out, seen = [], set()
    for r in (raw if isinstance(raw, list) else [])[:6]:
        if not isinstance(r, dict):
            continue
        try:
            name = check_name(str(r.get("name") or ""))
        except DbxError:
            continue
        if name in seen:
            continue
        seen.add(name)
        kind = str(r.get("kind") or "")
        out.append({
            "name": name,
            "label": str(r.get("label") or name).strip()[:60],
            "what_for": str(r.get("what_for") or "").strip()[:300],
            "how_to_get": str(r.get("how_to_get") or "").strip()[:500],
            "kind": kind if kind in KINDS else "secret_text",
        })
    return out
