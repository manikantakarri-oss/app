"""Run SQL as the portal's own identity, for the tables the portal keeps.

Shared by the problem log (`logsink`) and saved conversations (`chats`). The
app's service principal needs CAN_USE on a warehouse; PORTAL_LOG_WAREHOUSE pins
one, otherwise the first (preferring a running one) is used.
"""
from __future__ import annotations

import os

import httpx

from dbx import DbxError, app_token, host, http

WAREHOUSE = os.environ.get("PORTAL_LOG_WAREHOUSE", "").strip()


def run(statement: str, params: list | None = None) -> list:
    """Run one SQL statement as the app identity and return its rows."""
    tok = app_token()
    wh = WAREHOUSE or _first_warehouse(tok)
    body = {"statement": statement, "warehouse_id": wh, "wait_timeout": "30s"}
    if params:
        body["parameters"] = params
    resp = http().post(
        host() + "/api/2.0/sql/statements",
        headers={"Authorization": "Bearer " + tok},
        json=body,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise DbxError((resp.text or "")[:300], resp.status_code)
    data = resp.json()
    status = data.get("status") or {}
    if status.get("state") in ("FAILED", "CANCELED", "CLOSED"):
        raise DbxError(str((status.get("error") or {}).get("message") or status["state"])[:300], 502)
    return (data.get("result") or {}).get("data_array") or []


def _first_warehouse(tok: str) -> str:
    resp = http().get(
        host() + "/api/2.0/sql/warehouses", headers={"Authorization": "Bearer " + tok}, timeout=30
    )
    if resp.status_code >= 400:
        raise DbxError("could not list warehouses: " + (resp.text or "")[:200], resp.status_code)
    whs = resp.json().get("warehouses") or []
    if not whs:
        raise DbxError("the portal can use no SQL warehouse; give its service principal CAN_USE on one", 503)
    for w in whs:
        if w.get("state") == "RUNNING":
            return w["id"]
    return whs[0]["id"]
