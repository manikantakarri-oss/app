"""Is the deployer ready to deploy? Each thing it depends on, checked up front,
with the fix in plain words, so a missing token or permission shows on the
Setup page instead of as an error halfway through adding a client.

Read-only: nothing here creates, changes or dispatches anything. GitHub does
not report what a fine-grained token may WRITE, so the token checks read what
the deployer's writes need (a token that can read repository administration
settings almost always got Administration "Read and write"; the first Add client
confirms the write).
"""
from __future__ import annotations

import time

import ghub
import registry
from common import DeployError

HOME_VARS = ("HOME_HOST", "HOME_CLIENT_ID", "HOME_WAREHOUSE_ID", "REGISTRY_SCHEMA")
_cache: dict = {}


def _row(key: str, label: str, ok: bool, detail: str = "", fix: str = "", level: str = "") -> dict:
    return {"key": key, "label": label, "status": level or ("ok" if ok else "fail"), "detail": detail, "fix": fix}


def _actions_on(d: dict) -> tuple[bool, str]:
    on = bool(d.get("enabled"))
    return on, "GitHub Actions is on for the repository." if on else "GitHub Actions is switched off for the repository."


def _workflows(d: dict) -> tuple[bool, str]:
    names = {w.get("path", "").rsplit("/", 1)[-1] for w in d.get("workflows") or []}
    missing = sorted({"deploy.yml", "health.yml"} - names)
    return not missing, "deploy.yml and health.yml are in the repository." if not missing else "Missing: %s." % ", ".join(missing)


def _variables(d: dict) -> tuple[bool, str]:
    have = {v.get("name") for v in d.get("variables") or []}
    missing = [v for v in HOME_VARS if v not in have]
    return not missing, "All four are set." if not missing else "Missing: %s." % ", ".join(missing)


def _secret(d: dict) -> tuple[bool, str]:
    ok = "HOME_CLIENT_SECRET" in {v.get("name") for v in d.get("secrets") or []}
    return ok, "HOME_CLIENT_SECRET is set." if ok else "HOME_CLIENT_SECRET is missing."


def checks(fresh: bool = False) -> dict:
    hit = _cache.get("r")
    if hit and not fresh and hit[0] > time.time():
        return hit[1]
    repo = ghub.repo()
    rows: list[dict] = []
    token_ok = True
    try:
        ghub.token()
    except DeployError as exc:
        token_ok = False
        rows.append(_row("token", "GitHub key", False, str(exc),
                         "Store a fine-grained GitHub token in the Databricks secret scope portal-deployer (key "
                         "github-token), add it to the app as the secret resource github-token, then deploy the app again."))
    if token_ok:
        try:
            ghub.call("GET", "/repos/%s" % repo)
            rows.append(_row("token", "GitHub key", True, "Connected to %s." % repo))
        except DeployError as exc:
            token_ok = False
            rows.append(_row("token", "GitHub key", False, str(exc),
                             "Make sure the token is for the repository %s and has not expired." % repo))

    def gh(key, label, path, ok_detail, fix, judge=None):
        if not token_ok:
            rows.append(_row(key, label, False, "Needs the GitHub key first.", fix, "blocked"))
            return None
        try:
            d = ghub.call("GET", path)
        except DeployError as exc:
            rows.append(_row(key, label, False, str(exc), fix))
            return None
        verdict = judge(d) if judge else (True, ok_detail)
        rows.append(_row(key, label, verdict[0], verdict[1], "" if verdict[0] else fix))
        return d

    gh("admin", "Permission to create client environments", "/repos/%s/actions/permissions" % repo, "",
       "Edit the GitHub token: give it Administration, Read and write.", _actions_on)
    gh("workflows", "Deploy and check jobs", "/repos/%s/actions/workflows" % repo, "",
       "Push the latest code to main: .github/workflows/deploy.yml and health.yml must be in the repository.",
       _workflows)
    gh("vars", "Repository variables", "/repos/%s/actions/variables?per_page=30" % repo, "",
       "In the repository: Settings, Secrets and variables, Actions, Variables tab. Add the missing ones (see the "
       "setup guide), and give the token Variables, Read and write.", _variables)
    gh("secret", "Repository secret", "/repos/%s/actions/secrets?per_page=30" % repo, "",
       "In the repository: Settings, Secrets and variables, Actions, Secrets tab: New repository secret "
       "HOME_CLIENT_SECRET. Give the token Secrets, Read and write.", _secret)
    rel = []
    if token_ok:
        try:
            rel = ghub.releases()
            stable = [r for r in rel if not r["prerelease"]]
            rows.append(_row("release", "A published version", bool(rel),
                             ("%d published, newest %s." % (len(rel), (stable or rel)[0]["version"])) if rel
                             else "No version is published yet, so there is nothing to deploy.",
                             "" if rel else "Publish one: git tag v1.0.0, then git push origin v1.0.0. "
                                            "The tests run and the version appears under Releases."))
        except DeployError as exc:
            rows.append(_row("release", "A published version", False, str(exc), "Check the GitHub key."))
    else:
        rows.append(_row("release", "A published version", False, "Needs the GitHub key first.", "", "blocked"))
    try:
        registry.ensure()
        rows.append(_row("record", "Deploy history", True, "Stored in %s." % registry.schema()))
    except DeployError as exc:
        rows.append(_row("record", "Deploy history", False, str(exc),
                         "Give the deployer app's service principal USE CATALOG on the catalog and USE SCHEMA, "
                         "CREATE TABLE, SELECT, MODIFY on %s, plus Can use on a SQL warehouse." % registry.schema()))
    bad = [r for r in rows if r["status"] != "ok"]
    out = {"ready": not bad, "problems": len(bad), "checks": rows, "repo": repo, "checked_at": int(time.time())}
    _cache["r"] = (time.time() + 60, out)
    return out
