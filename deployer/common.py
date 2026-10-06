"""Small HTTP helpers shared by the deployer app and the GitHub Actions scripts.

Everything here talks to a Databricks workspace with an OAuth token. A client
workspace is reached with that client's service principal (machine-to-machine
OAuth: `POST /oidc/v1/token`, `grant_type=client_credentials`, `scope=all-apis`),
our own workspace with the deployer's identity. No SDK: httpx only, like the
portal, so the scripts run on a bare GitHub runner after one `pip install`.
"""
from __future__ import annotations

import base64
import binascii
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
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# GitHub caps a variable at 48 KB; the deployer UI shrinks logos well under this.
LOGO_MAX = 40_000
PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


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
        try:
            why = r.json().get("error_description") or ""
        except ValueError:
            why = ""
        # Seen live (AWS, 2026-10-06): an OAuth *app connection*'s id and
        # secret authenticate fine but answer 403 "Scopes 'all-apis' are not
        # assigned to the client". It is not a service principal.
        if "not assigned to the client" in why:
            raise DeployError("The id and secret are right, but that login may not call Databricks APIs. It is "
                              "probably an OAuth app connection, not a service principal. In the workspace, open "
                              "Settings, Identity and access, Service principals, add one, put it in the admins "
                              "group, and generate the secret on its Secrets tab. (Databricks: %s)" % why[:200], 401)
        if r.status_code == 401 or "authentication failed" in why.lower():
            raise DeployError("The workspace did not recognise that id and secret. Check both, and that the secret "
                              "has not expired.", 401)
        raise DeployError("The workspace refused the service principal (HTTP %d)%s" % (
            r.status_code, (": " + why[:200]) if why else "."), 401)
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


def check_logo(logo: str) -> bytes:
    prefix = "data:image/png;base64,"
    if not logo.startswith(prefix):
        raise DeployError("The logo must be a PNG image.")
    if len(logo) > LOGO_MAX:
        raise DeployError("The logo is too large. Use a smaller image (it is stored at up to 256 pixels).")
    try:
        raw = base64.b64decode(logo[len(prefix):], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise DeployError("The logo could not be read.") from exc
    if raw[:8] != PNG_MAGIC or len(raw) < 24:
        raise DeployError("The logo is not a valid PNG image.")
    w, h = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if not (1 <= w <= 512 and 1 <= h <= 512):
        raise DeployError("The logo must be at most 512 pixels on each side.")
    return raw
