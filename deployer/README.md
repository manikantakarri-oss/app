# Portal Deployer

The Portal Deployer puts the Agent Portal into client Databricks workspaces. You can deploy any released version to any client, see what each client runs and how healthy it is, and roll back. A deploy whose new version does not come up is rolled back automatically.

| Piece | Where it lives |
|---|---|
| The deployer UI and API | A Databricks App in **our** workspace (`deployer/`, UI built from `ui/` with `npm run build:deployer`) |
| Clients | GitHub Environments `client-<name>` in this repo: settings as variables, the service principal secret as an encrypted secret |
| Versions | GitHub Releases (`vX.Y.Z`), published by `.github/workflows/release.yml` after the tests pass |
| Deploy, rollback, health check | GitHub Actions: `deploy.yml`, `health.yml` (scripts `deployer/deploy.py`, `deployer/health.py`) |
| Record of what happened | Delta tables `deployments` and `health` in `REGISTRY_SCHEMA` (default `databrickspoc.portal_deployer`) |

Like the portal itself, the deployer stores nothing of its own. If you delete it and set it up again, no client, version or history is lost.

## What one Deploy does

1. Signs in to the client workspace as the client's service principal.
2. Creates the app if it is missing, and makes sure its compute is running.
3. Sets up access. These steps produce warnings only and never fail a deploy:
   - lets the client's users group open the app;
   - gives the app's own identity `CAN_USE` on a SQL warehouse;
   - creates the history schema and grants the app on it.
4. Uploads the release to `/Workspace/Users/<sp-id>/agent-portal/<app>/<version>`. The folder name is the version, so Databricks itself records which version is live.
5. Sets the user API scopes from `update-scopes.json` on the app record, deploys, and restarts the app if the scopes changed.
6. Checks that Databricks reports the app running and that the portal's `/api/health` reports the expected version.
7. If anything from step 4 on fails, the previously live version is deployed again from its folder and checked. Both attempts are recorded.

## One-time setup

### 1. Our workspace: an identity for GitHub Actions to write the record

1. Create a service principal, for example `portal-deployer-ci`, and generate an OAuth secret for it.
2. Run these grants on the registry schema:

   ```sql
   GRANT USE CATALOG ON CATALOG databrickspoc TO `<ci-sp-application-id>`;
   GRANT USE SCHEMA, CREATE TABLE, SELECT, MODIFY ON SCHEMA databrickspoc.portal_deployer TO `<ci-sp-application-id>`;
   ```

   Create the schema first if it does not exist.
3. Give it `CAN_USE` on one SQL warehouse.

### 2. GitHub repository settings (Settings → Secrets and variables → Actions)

| Kind | Name | Value |
|---|---|---|
| Variable | `HOME_HOST` | `https://adb-7405615965667597.17.azuredatabricks.net` |
| Variable | `HOME_CLIENT_ID` | the CI service principal's application id |
| Secret | `HOME_CLIENT_SECRET` | its OAuth secret |
| Variable | `HOME_WAREHOUSE_ID` | the warehouse id |
| Variable | `REGISTRY_SCHEMA` | `databrickspoc.portal_deployer` |

### 3. A GitHub token for the deployer app

Create a fine-grained personal access token (or a GitHub App token) scoped to **this repository only**, with these permissions:

- Read and write: Actions, Environments, Secrets, Variables
- Read: Contents, Metadata

Store it in a Databricks secret scope:

```bash
databricks secrets create-scope portal-deployer -p azure-prem
databricks secrets put-secret portal-deployer github-token -p azure-prem   # paste the token
```

### 4. Deploy the deployer app (in our workspace)

```bash
cd ui && npm install && npm run build:deployer && cp -r out-deployer/. ../deployer/web/ && cd ..

P=azure-prem
U=$(databricks current-user me -p $P -o json | python -c "import sys,json;print(json.load(sys.stdin)['userName'])")
databricks apps create portal-deployer -p $P
databricks workspace import-dir deployer "/Users/$U/portal-deployer" --overwrite -p $P
```

1. Give the app the token. In the app's settings, add a **Secret** resource named `github-token`: scope `portal-deployer`, key `github-token`, permission Read. `app.yaml` reads it with `valueFrom: github-token`.
2. Deploy:

   ```bash
   databricks apps deploy portal-deployer --source-code-path "/Workspace/Users/$U/portal-deployer" -p $P
   ```

3. Grant the app's own service principal what it needs to read the record and create it on first use:
   - `USE CATALOG` on `databrickspoc`
   - `USE SCHEMA`, `CREATE TABLE`, `SELECT`, `MODIFY` on `databrickspoc.portal_deployer`
   - `CAN_USE` on a SQL warehouse
4. Give the people who deploy `CAN_USE` on the app. Only members of `DEPLOYER_GROUP` (default `admins`) can do anything in it.

### 5. Publish the first version

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The Release workflow runs the tests and publishes `v1.0.0`, which then appears under **Releases**.

## Adding a client

Ask the client's workspace admin to:

1. Create a service principal in their workspace.
2. Add it to the **admins** group.
3. Generate an OAuth secret for it.
4. For chat history, grant it `USE CATALOG` and `CREATE SCHEMA` on the catalog where history should live.

Then, in the deployer:

1. Click **Add client**.
2. Fill in their workspace address, the application id and the secret.
3. Click **Test connection**, then **Add client**.
4. Open the client, pick a version and click **Deploy**.

## Run it locally

```bash
pip install -r deployer/requirements.txt
cd deployer && python -m uvicorn app:app --port 8812     # http://127.0.0.1:8812
```

Locally, the deployer signs in to Databricks with your CLI profile (`azure-prem`) and to GitHub with `gh auth token`.

Tests: `python deployer/test_deployer.py` (offline). They also run in CI with the portal's tests.

## Not yet run live

These were built from the API references and tested offline only:

- The deploy workflow against a real client workspace.
- Reaching the app's `/api/health` with the service principal's OAuth token. If the app refuses it, the check falls back to Databricks' own view of the app and says the inside check was skipped.
- Reading error counts. This needs the client's service principal to count as a portal admin, which it does when it is in the client's `admins` group.

Do a first dry run against a test workspace, or against our own workspace with a different app name, before the first real client.
