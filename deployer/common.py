"""Small HTTP helpers shared by the deployer app and the GitHub Actions scripts.

Everything here talks to a Databricks workspace with an OAuth token. A client
workspace is reached with that client's service principal (machine-to-machine
OAuth: `POST /oidc/v1/token`, `grant_type=client_credentials`, `scope=all-apis`),
our own workspace with the deployer's identity. No SDK: httpx only, like the
portal, so the scripts run on a bare GitHub runner after one `pip install`.
"""
from __future__ import annotations

import re
import time

import httpx

TIMEOUT = httpx.Timeout(60.0, connect=15.0)

# Names that end up inside SQL identifiers or URLs are checked against these
# first; nothing user-typed is ever pasted into a statement unchecked.
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$")
TABLE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$")
SCHEMA_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$")
APP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,29}$")  # Databricks app names: lowercase, digits, dashes, 2-30
CLIENT_RE = re.compile(r"^client-[a-z0-9][a-z0-9-]{1,38}$")
VERSION_RE = re.compile(r"^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
GROUP_RE = re.compile(r"^[A-Za-z0-9 _.@-]{1,100}$")
WAREHOUSE_RE = re.compile(r"^[0-9a-f]{16}$")


class DeployError(Exception):
    """A failure with a message fit to show a person. `status` mirrors HTTP."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def host(raw: str) -> str:
    """`https://adb-1.2.azuredatabricks.net` from whatever was typed or injected
    (Databricks Apps injects DATABRICKS_HOST without a scheme)."""
    h = (raw or "").strip().rstrip("/")
    if not h:
        return ""
    if not h.startswith("http"):
        h = "https://" + h
    if not re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?$", h):
        raise DeployError("That workspace address does not look right. Use the address you open Databricks with, "
                          "for example https://adb-1234567890123456.7.azuredatabricks.net")
    return h


def m2m_token(workspace: str, client_id: str, secret: str) -> str:
    """An OAuth token for a service principal (machine-to-machine)."""
    try:
        r = httpx.post(host(workspace) + "/oidc/v1/token", data={"grant_type": "client_credentials", "scope": "all-apis"},
                       auth=(client_id, secret), timeout=TIMEOUT)
    except httpx.HTTPError as exc:
        raise DeployError("Could not reach the workspace (%s)." % type(exc).__name__, 502) from exc
    if r.status_code != 200:
        raise DeployError("The workspace refused the service principal's id and secret (HTTP %d). Check both, and that "
                          "the secret has not expired." % r.status_code, 401)
    return r.json()["access_token"]


class Api:
    """One workspace, one token. `call` raises DeployError with Databricks' own message."""

    def __init__(self, workspace: str, token: str):
        self.host = host(workspace)
        self.token = token

    def call(self, method: str, path: str, *, json=None, params=None, quiet_404: bool = False):
        try:
            r = httpx.request(method, self.host + path, json=json, params=params, timeout=TIMEOUT,
                              headers={"Authorization": "Bearer " + self.token})
        except httpx.HTTPError as exc:
            raise DeployError("%s %s: could not reach Databricks (%s)" % (method, path, type(exc).__name__), 502) from exc
        if r.status_code == 404 and quiet_404:
            return None
        if r.status_code >= 400:
            raise DeployError(_message(r), r.status_code)
        return r.json() if r.content else {}


def _message(r: httpx.Response) -> str:
    try:
        body = r.json()
        msg = body.get("message") or body.get("error_description") or body.get("error") or ""
    except ValueError:
        msg = r.text[:300]
    return (msg or "HTTP %d" % r.status_code)[:500]


def wait(check, timeout: float, every: float = 10.0, sleep=None, clock=None):
    """Call `check()` until it returns something truthy or `timeout` passes.
    Returns the value, or None on timeout. `sleep`/`clock` are injectable for
    tests; otherwise `time.sleep`/`time.monotonic` are looked up at call time."""
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    end = clock() + timeout
    while True:
        got = check()
        if got:
            return got
        if clock() >= end:
            return None
        sleep(every)
