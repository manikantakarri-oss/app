"""Our own workspace (where the deployer and its registry live): who we are there.

Three ways in, first match wins:
- GitHub Actions: HOME_HOST + HOME_CLIENT_ID + HOME_CLIENT_SECRET (a service
  principal kept as repository secrets/variables), used to write the registry.
- Databricks Apps: the runtime injects DATABRICKS_HOST / DATABRICKS_CLIENT_ID /
  DATABRICKS_CLIENT_SECRET for the deployer app's own identity.
- Local development: the Databricks CLI profile (DATABRICKS_CONFIG_PROFILE,
  default azure-prem), for both the app identity and "the signed-in user".
"""
from __future__ import annotations

import json
import os
import subprocess
import time

from common import DeployError, host, m2m_token

PROFILE = os.environ.get("DATABRICKS_CONFIG_PROFILE", "azure-prem")
_cache: dict = {}


def mode() -> str:
    if os.environ.get("HOME_CLIENT_ID"):
        return "actions"
    if os.environ.get("DATABRICKS_CLIENT_ID"):
        return "apps"
    return "local"


def _cli(args: list[str]) -> dict:
    out = subprocess.run(["databricks", *args, "--profile", PROFILE, "-o", "json"], capture_output=True, text=True,
                         timeout=60, shell=os.name == "nt")
    if out.returncode != 0:
        raise DeployError("Databricks CLI failed: " + (out.stderr or out.stdout)[:200], 401)
    return json.loads(out.stdout or "{}")


def home_host() -> str:
    m = mode()
    if m == "actions":
        return host(os.environ.get("HOME_HOST", ""))
    if m == "apps" or os.environ.get("DATABRICKS_HOST"):
        return host(os.environ.get("DATABRICKS_HOST", ""))
    if "host" not in _cache:
        _cache["host"] = host(_cli(["auth", "env"]).get("env", {}).get("DATABRICKS_HOST", ""))
    return _cache["host"]


def app_token() -> str:
    """The deployer's own identity in our workspace (reads/writes the registry)."""
    tok, until = _cache.get("tok", ("", 0.0))
    if tok and until > time.time() + 60:
        return tok
    m = mode()
    if m == "actions":
        tok = m2m_token(home_host(), os.environ["HOME_CLIENT_ID"], os.environ.get("HOME_CLIENT_SECRET", ""))
    elif m == "apps":
        tok = m2m_token(home_host(), os.environ["DATABRICKS_CLIENT_ID"], os.environ.get("DATABRICKS_CLIENT_SECRET", ""))
    else:
        tok = _cli(["auth", "token"]).get("access_token", "")
    _cache["tok"] = (tok, time.time() + 1800)
    return tok


def user_token(forwarded: str | None) -> str:
    """The signed-in person's token. In Apps it must be forwarded, or we refuse."""
    if forwarded:
        return forwarded
    if mode() == "apps":
        raise DeployError("You are not signed in.", 403)
    return app_token()
