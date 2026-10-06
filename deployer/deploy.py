"""Deploy (or roll back) one release of the Agent Portal to one client.

Run by `.github/workflows/deploy.yml` inside the client's GitHub Environment,
so the client's service principal secret is only ever an environment variable
of this process. Steps, each written to the deployment record as it happens:

  1. sign in to the client's workspace as its service principal
  2. make sure the app exists and its compute is running
  3. access: open the app to the client's users group, let the app use a SQL
     warehouse, create the history schema and grant the app on it
  4. upload the release to its own folder (the folder name is the version)
  5. set the user API scopes on the app record
  6. deploy, then restart if the scopes changed (they only apply after a restart)
  7. verify: Databricks says it is running, and the portal answers with the
     expected version

If anything from step 4 on fails and another version was live before, that
version is put back automatically (its folder is still there) and verified, and
both attempts are recorded. Access problems (step 3) are warnings, never a
failed deploy: the portal runs without history, it just cannot save chats.

Inputs (environment): CLIENT, VERSION, ACTION (deploy|rollback), DEPLOY_ID,
ACTOR, RUN_URL; the client's DATABRICKS_HOST, DATABRICKS_CLIENT_ID,
DATABRICKS_CLIENT_SECRET, APP_NAME, PORTAL_LOG_TABLE, WAREHOUSE_ID, USERS_GROUP;
and HOME_* / REGISTRY_SCHEMA for the record (see home.py, registry.py).
"""
from __future__ import annotations

import os
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import registry  # noqa: E402
import workspace as ws  # noqa: E402
from common import APP_RE, CLIENT_RE, ID_RE, VERSION_RE, Api, DeployError, m2m_token  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def config(env: dict) -> dict:
    c = {
        "client": env.get("CLIENT", ""),
        "version": env.get("VERSION", ""),
        "action": env.get("ACTION") or "deploy",
        "deploy_id": env.get("DEPLOY_ID") or str(uuid.uuid4()),
        "actor": env.get("ACTOR", ""),
        "run_url": env.get("RUN_URL", ""),
        "host": env.get("DATABRICKS_HOST", ""),
        "client_id": env.get("DATABRICKS_CLIENT_ID", ""),
        "secret": env.get("DATABRICKS_CLIENT_SECRET", ""),
        "app": env.get("APP_NAME") or "agent-portal",
        "log_table": env.get("PORTAL_LOG_TABLE", ""),
        "warehouse": env.get("WAREHOUSE_ID", ""),
        "users_group": "" if (env.get("USERS_GROUP") or "users").lower() in ("-", "none") else (env.get("USERS_GROUP") or "users"),
    }
    # Inputs reach this script as environment variables, never pasted into the
    # workflow's shell, and are checked before use.
    if not CLIENT_RE.match(c["client"]):
        raise DeployError("Unknown client %r." % c["client"])
    if not VERSION_RE.match(c["version"]):
        raise DeployError("Not a release version: %r" % c["version"])
    if c["action"] not in ("deploy", "rollback"):
        raise DeployError("Unknown action %r." % c["action"])
    if not ID_RE.match(c["deploy_id"]):
        raise DeployError("Bad deploy id.")
    if not APP_RE.match(c["app"]):
        raise DeployError("APP_NAME %r is not allowed." % c["app"])
    if not (c["host"] and c["client_id"] and c["secret"]):
        raise DeployError("This client is missing its workspace address, service principal id or secret. "
                          "Open it in the deployer and fill in its settings.")
    return c


class Recorder:
    """Writes each step to the deployment record and to the job log."""

    def __init__(self, c: dict, write=None):
        self.c = c
        self.write = write or (lambda **kw: registry.safe(registry.record, **kw))
        self.from_version = ""
        self.warnings: list[str] = []
        self.failed_from = False

    def __call__(self, status: str, step: str, message: str = "", **detail):
        print("[%s] %s%s" % (status, step, (": " + message) if message else ""), flush=True)
        self.write(deploy_id=self.c["deploy_id"], client=self.c["client"], action=self.c["action"],
                   version=self.c["version"], status=status, step=step, message=message,
                   from_version=self.from_version, actor=self.c["actor"], run_url=self.c["run_url"],
                   detail={"warnings": self.warnings, **detail})

    def say(self, step: str):
        self("running", step)


def verify(api: Api, app: str, version: str, timeout: float = 300, **kw) -> dict:
    """Wait for the app to come up on `version`. Raises if it does not."""
    last = {}

    def ok():
        nonlocal last
        last = ws.check(api, app, expect=version)
        if last["status"] in ("healthy", "unverified"):
            return last
        if last["status"] == "degraded" and last.get("version") == version:
            return last  # up on the right version; failing questions are not the release's fault
        return None

    got = ws.wait(ok, timeout, every=15, **kw)
    if not got:
        raise DeployError("The portal did not come up on %s: %s" % (version, last.get("summary", "no answer")), 502)
    return got


def ship(api: Api, c: dict, rec: Recorder, scopes: list[str], workdir: str, **kw) -> dict:
    """Steps 2-7 for c['version']. Returns the health result. Sets rec.from_version."""
    rec.say("Getting the app ready")
    app, created = ws.ensure_app(api, c["app"], scopes, rec.say)
    rec.from_version = ws.version_of((app.get("active_deployment") or {}).get("source_code_path", ""))
    rec.say("Setting up access")
    try:
        warehouse = ws.pick_warehouse(api, c["warehouse"])
    except DeployError as exc:
        warehouse = ""
        rec.warnings.append("Could not find a SQL warehouse: %s" % exc)
    rec.warnings += ws.grant_access(api, app, c["log_table"], warehouse, c["users_group"], rec.say)
    path = ws.release_path(c["client_id"], c["app"], c["version"])
    ws.stage(REPO, c["version"], os.path.join(workdir, "release"), c["log_table"], warehouse)
    ws.upload(os.path.join(workdir, "release"), path, rec.say)
    rec.failed_from = True  # the live app changes from here, so a failure puts the old version back
    changed = ws.set_scopes(api, c["app"], app, scopes, rec.say)
    ws.deploy(api, c["app"], path, rec.say, **kw)
    if changed and not created:
        ws.restart(api, c["app"], rec.say, **kw)
    rec.say("Checking the portal is up")
    return verify(api, c["app"], c["version"], **kw)


def roll_back(api: Api, c: dict, rec: Recorder, reason: str, **kw) -> int:
    """Put rec.from_version back after a failed deploy. Returns the exit code."""
    prev = rec.from_version
    rec("running", "Putting %s back" % prev, reason)
    back = {**c, "deploy_id": str(uuid.uuid4()), "action": "auto_rollback", "version": prev}
    brec = Recorder(back, rec.write)
    brec.from_version = c["version"]
    try:
        brec.say("Putting %s back after %s failed" % (prev, c["version"]))
        ws.deploy(api, c["app"], ws.release_path(c["client_id"], c["app"], prev), brec.say, **kw)
        h = verify(api, c["app"], prev, **kw)
    except DeployError as exc:
        brec("failed", "Could not put %s back" % prev, str(exc))
        rec("failed", "Failed, and putting %s back also failed" % prev, "%s Then: %s" % (reason, exc))
        return 1
    brec("succeeded", "Back on %s" % prev, h.get("summary", ""), health=h)
    registry.safe(registry.record_health, str(uuid.uuid4()), c["client"], h, c["actor"], c["run_url"])
    rec("rolled_back", "Rolled back to %s" % prev, reason, rolled_back_to=prev, rollback_id=back["deploy_id"])
    return 1


def run(c: dict, rec: Recorder, api: Api, scopes: list[str], workdir: str, **kw) -> int:
    try:
        h = ship(api, c, rec, scopes, workdir, **kw)
    except DeployError as exc:
        if rec.failed_from and rec.from_version and rec.from_version != c["version"]:
            return roll_back(api, c, rec, str(exc), **kw)
        rec("failed", "Failed", str(exc))
        return 1
    registry.safe(registry.record_health, str(uuid.uuid4()), c["client"], h, c["actor"], c["run_url"])
    note = " (%d warning%s)" % (len(rec.warnings), "" if len(rec.warnings) == 1 else "s") if rec.warnings else ""
    rec("succeeded", "Live on %s%s" % (c["version"], note), h.get("summary", ""), health=h, url=h.get("url", ""))
    return 0


def main() -> int:
    try:
        c = config(dict(os.environ))
    except DeployError as exc:
        print("::error::%s" % exc)
        return 2
    rec = Recorder(c)
    rec.say("Signing in to the client's workspace")
    try:
        api = Api(c["host"], m2m_token(c["host"], c["client_id"], c["secret"]))
        scopes = ws.scopes_from(REPO)
    except DeployError as exc:
        rec("failed", "Could not sign in", str(exc))
        return 1
    with tempfile.TemporaryDirectory() as workdir:
        code = run(c, rec, api, scopes, workdir)
    if code:
        print("::error::The deploy did not go through. See the deployer for details.")
    return code


if __name__ == "__main__":
    sys.exit(main())
