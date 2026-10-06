"""Check one client's portal and record the result ("Check now" in the deployer).

Run by `.github/workflows/health.yml` inside the client's GitHub Environment.
Records: Databricks' view of the app (running, which version is live), the
portal's own answer on /api/health, and errors in the last day from the
portal's Monitoring and log (when the service principal counts as a portal
admin). Never fails the job for an unhealthy portal: the result is the record.

Inputs (environment): CLIENT, CHECK_ID, ACTOR, RUN_URL, the client's
DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET / APP_NAME,
and HOME_* / REGISTRY_SCHEMA for the record.
"""
from __future__ import annotations

import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import registry  # noqa: E402
import workspace as ws  # noqa: E402
from common import APP_RE, CLIENT_RE, ID_RE, Api, DeployError, m2m_token  # noqa: E402


def main(env=None) -> int:
    env = dict(os.environ if env is None else env)
    client, check_id = env.get("CLIENT", ""), env.get("CHECK_ID") or str(uuid.uuid4())
    app = env.get("APP_NAME") or "agent-portal"
    if not CLIENT_RE.match(client) or not ID_RE.match(check_id) or not APP_RE.match(app):
        print("::error::Bad input (client, check id or app name).")
        return 2
    try:
        api = Api(env.get("DATABRICKS_HOST", ""), m2m_token(env.get("DATABRICKS_HOST", ""),
                                                            env.get("DATABRICKS_CLIENT_ID", ""),
                                                            env.get("DATABRICKS_CLIENT_SECRET", "")))
        result = ws.check(api, app)
    except DeployError as exc:
        result = {"status": "down", "summary": "Could not check: %s" % exc, "version": ""}
    print("[%s] %s" % (result["status"], result.get("summary", "")), flush=True)
    registry.safe(registry.record_health, check_id, client, result, env.get("ACTOR", ""), env.get("RUN_URL", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
