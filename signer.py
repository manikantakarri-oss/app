"""Tamper-evident permits the portal hands to the browser and accepts back.

The portal keeps no state, so anything it must trust on a later request travels through
the browser: a download permit for a file an agent named in its reply (so any agent's files
can be downloaded without an admin first declaring its folder), and the paused state of an
answer waiting for a person to approve a tool. Both are HMAC-signed here and checked when
they come back; a changed or expired permit is refused.

The key is derived from the app's own OAuth secret (stable across restarts, never shown),
or PORTAL_SIGNING_KEY if set. Local dev without either uses a random key per process, so
permits only last until a restart there. A permit never widens access: downloads and tool
calls still run under the person's own token, so Databricks decides.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

_key: bytes | None = None


def _secret() -> bytes:
    global _key
    if _key is None:
        seed = os.environ.get("PORTAL_SIGNING_KEY") or os.environ.get("DATABRICKS_CLIENT_SECRET") or ""
        _key = hashlib.sha256(("agent-portal-permits|" + seed).encode()).digest() if seed else secrets.token_bytes(32)
    return _key


def _canon(data) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def mac(data) -> str:
    """A signature for any JSON-able value."""
    return base64.urlsafe_b64encode(hmac.new(_secret(), _canon(data), hashlib.sha256).digest()[:24]).decode().rstrip("=")


def check(data, signature: str) -> bool:
    return bool(signature) and hmac.compare_digest(mac(data), str(signature))


def permit(fields: dict, ttl: int) -> str:
    """A compact signed token holding `fields` until `ttl` seconds from now."""
    body = dict(fields, x=int(time.time()) + ttl)
    raw = base64.urlsafe_b64encode(_canon(body)).decode().rstrip("=")
    return raw + "." + mac(body)


def read(token: str) -> dict | None:
    """The fields of a valid, unexpired permit, else None."""
    try:
        raw, sig = str(token or "").split(".", 1)
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (ValueError, TypeError):
        return None
    if not isinstance(body, dict) or not check(body, sig) or int(body.get("x") or 0) < time.time():
        return None
    return body
