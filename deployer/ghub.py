"""GitHub: where clients, their secrets, releases and the deploy jobs live.

- A client is a GitHub Environment named `client-<slug>` in DEPLOYER_REPO.
  Its settings are environment variables (DATABRICKS_HOST, DATABRICKS_CLIENT_ID,
  APP_NAME, PORTAL_LOG_TABLE, WAREHOUSE_ID, USERS_GROUP, CLIENT_NAME); its
  service principal secret is an environment secret (DATABRICKS_CLIENT_SECRET),
  encrypted here with the environment's public key (libsodium sealed box) before
  it leaves this process. GitHub never gives a secret back, and neither do we.
- A version is a GitHub Release (tag `vX.Y.Z`), cut by release.yml after the
  offline tests pass.
- Deploys and checks are workflow_dispatch runs of deploy.yml / health.yml.

The deployer's token is GITHUB_TOKEN (a fine-grained token on this repository
with Actions, Environments, Secrets and Variables read/write and Contents read),
given to the app as a secret resource. Local development falls back to `gh auth token`.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
import time

import httpx

from common import CLIENT_RE, DeployError

API = "https://api.github.com"
_cache: dict = {}
VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def repo() -> str:
    r = os.environ.get("DEPLOYER_REPO") or "manikantakarri-oss/app"
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", r):
        raise DeployError("DEPLOYER_REPO must be owner/name.", 500)
    return r


def ref() -> str:
    return os.environ.get("DEPLOYER_REF") or "main"


def token() -> str:
    t = os.environ.get("GITHUB_TOKEN", "")
    if t:
        return t
    if "gh" not in _cache:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=30, shell=os.name == "nt")
        _cache["gh"] = out.stdout.strip() if out.returncode == 0 else ""
    if not _cache["gh"]:
        raise DeployError("The deployer has no GitHub token (GITHUB_TOKEN).", 500)
    return _cache["gh"]


def call(method: str, path: str, *, json=None, params=None, ok404: bool = False, http=httpx):
    try:
        r = http.request(method, API + path, json=json, params=params, timeout=30,
                         headers={"Authorization": "Bearer " + token(), "Accept": "application/vnd.github+json",
                                  "X-GitHub-Api-Version": "2022-11-28"})
    except httpx.HTTPError as exc:
        raise DeployError("Could not reach GitHub (%s)." % type(exc).__name__, 502) from exc
    if r.status_code == 404 and ok404:
        return None
    if r.status_code == 401:
        raise DeployError("GitHub refused the deployer's token. It may have expired; replace it.", 502)
    if r.status_code in (403, 404):
        raise DeployError("GitHub refused %s %s (HTTP %d). The deployer's token needs Actions, Environments, Secrets "
                          "and Variables write access on %s." % (method, path.split("?")[0], r.status_code, repo()), 502)
    if r.status_code >= 400:
        try:
            msg = r.json().get("message", "")
        except ValueError:
            msg = r.text[:200]
        raise DeployError("GitHub: %s (HTTP %d)" % (msg, r.status_code), 502)
    return r.json() if r.content else {}


def _check(env: str) -> str:
    if not CLIENT_RE.match(env):
        raise DeployError("Unknown client %r." % env, 404)
    return env


# --- clients (environments) --------------------------------------------------

def clients() -> list[str]:
    out, page = [], 1
    while True:
        d = call("GET", "/repos/%s/environments" % repo(), params={"per_page": 100, "page": page})
        envs = d.get("environments") or []
        out += [e["name"] for e in envs if CLIENT_RE.match(e.get("name", ""))]
        if len(envs) < 100:
            return sorted(out)
        page += 1


def variables(env: str) -> dict:
    d = call("GET", "/repos/%s/environments/%s/variables" % (repo(), _check(env)), params={"per_page": 30}, ok404=True)
    return {v["name"]: v["value"] for v in (d or {}).get("variables") or []}


def secret_set(env: str, name: str) -> str:
    """When the secret was last set ('' if never). GitHub never returns the value."""
    d = call("GET", "/repos/%s/environments/%s/secrets/%s" % (repo(), _check(env), name), ok404=True)
    return (d or {}).get("updated_at", "")


def create(env: str) -> None:
    call("PUT", "/repos/%s/environments/%s" % (repo(), _check(env)), json={})


def remove(env: str) -> None:
    call("DELETE", "/repos/%s/environments/%s" % (repo(), _check(env)))


def set_vars(env: str, values: dict, have: dict | None = None) -> None:
    """Create, change or (for an empty value) delete environment variables."""
    have = variables(env) if have is None else have
    base = "/repos/%s/environments/%s/variables" % (repo(), _check(env))
    for name, value in values.items():
        if not VAR_RE.match(name):
            raise DeployError("Bad variable name %r." % name, 400)
        value = (value or "").strip()
        if not value:
            if name in have:
                call("DELETE", base + "/" + name)
        elif name in have:
            if have[name] != value:
                call("PATCH", base + "/" + name, json={"name": name, "value": value})
        else:
            call("POST", base, json={"name": name, "value": value})


def seal(public_key_b64: str, value: str) -> str:
    """Encrypt for GitHub: a libsodium sealed box with the environment's key."""
    from nacl.public import PublicKey, SealedBox

    box = SealedBox(PublicKey(base64.b64decode(public_key_b64)))
    return base64.b64encode(box.encrypt(value.encode("utf-8"))).decode("ascii")


def set_secret(env: str, name: str, value: str) -> None:
    if not VAR_RE.match(name):
        raise DeployError("Bad secret name %r." % name, 400)
    base = "/repos/%s/environments/%s/secrets" % (repo(), _check(env))
    key = call("GET", base + "/public-key")
    call("PUT", base + "/" + name, json={"encrypted_value": seal(key["key"], value), "key_id": key["key_id"]})


# --- releases and runs ------------------------------------------------------

def releases() -> list[dict]:
    hit = _cache.get("releases")
    if hit and hit[0] > time.time():
        return hit[1]
    d = call("GET", "/repos/%s/releases" % repo(), params={"per_page": 50}) or []
    out = [{"version": r["tag_name"], "name": r.get("name") or r["tag_name"], "published_at": r.get("published_at") or "",
            "prerelease": bool(r.get("prerelease")), "notes": (r.get("body") or "")[:4000], "url": r.get("html_url", "")}
           for r in d if not r.get("draft") and r.get("tag_name")]
    _cache["releases"] = (time.time() + 60, out)
    return out


def dispatch(workflow: str, inputs: dict) -> None:
    call("POST", "/repos/%s/actions/workflows/%s/dispatches" % (repo(), workflow),
         json={"ref": ref(), "inputs": {k: str(v) for k, v in inputs.items()}})


def find_run(workflow: str, marker: str) -> dict | None:
    """The run whose title carries `marker` (deploy.yml/health.yml put the id in
    `run-name`), or None if GitHub has not started it yet."""
    d = call("GET", "/repos/%s/actions/workflows/%s/runs" % (repo(), workflow),
             params={"event": "workflow_dispatch", "per_page": 50}) or {}
    for r in d.get("workflow_runs") or []:
        if marker in (r.get("display_title") or ""):
            return {"status": r.get("status"), "conclusion": r.get("conclusion"), "url": r.get("html_url", "")}
    return None


def actions_url() -> str:
    return "https://github.com/%s/actions" % repo()
