# CLAUDE.md

Guidance for working in this repo. `README.md` has the long-form rationale and `TESTING.md` the test notes; this file is the map of what the app does and the rules that are easy to break.

## What this is

**Agent Portal** is a friendly front door to Databricks agents for people who never open a Databricks workspace. It is a Databricks App: a FastAPI backend (`app.py` + modules) serving a statically exported Next.js UI (`web/`).

- **End users** sign in, see only the agents they may use, and chat with them.
- **Admins** (members of the workspace `admins` group) manage access, build agents, control foundation-model access, and view cost, activity and problems.

**Core principle: the portal stores nothing of its own.** Agent identity, names, capabilities, access and the LLM switch all live in Databricks-native state (serving endpoint tags and ACLs, workspace groups, system tables). Delete and rebuild the portal and no configuration is lost. Don't add a local database or config file for state. The only tables the portal writes are the optional problem log and chat history in Delta (see below).

## Commands

Run from the repo root (`draft 4/draft 4/`, which has its own `.git`).

```bash
pip install -r requirements.txt                 # fastapi, uvicorn, httpx
export DATABRICKS_CONFIG_PROFILE=azure-prem     # CLI profile used in local dev
python -m uvicorn app:app --port 8811           # http://127.0.0.1:8811  (#admin opens the console)

python test_adapters.py                         # offline: reply-parsing / wire-format cases
python test_builder.py                          # offline: Supervisor Agent builder
python test_genie.py                            # offline: Genie space builder
python test_knowledge.py                        # offline: Knowledge Assistant builder
python test_dashboard.py                        # offline: per-person dashboards
./smoke.sh                                      # live checks vs local server (hits the real workspace; one check costs a few pennies)
./smoke.sh https://<app-url>                    # same, against the deployed app

python sync_agents.py                           # dry run: pull names/settings from Agent Bricks into endpoint tags
python sync_agents.py --apply [--force]         # write them

# UI: rebuild the static export, then copy into web/
cd ui && npm install && npm run build && cp -r out ../web
```

There is no linter or CI config. The offline tests are plain scripts (no pytest needed).

## Deploy

`app.yaml` is the Databricks Apps manifest (runs `uvicorn app:app --port 8000`). See README "Deploy from scratch". The gotchas:

- **Scopes are not applied from `app.yaml`.** Put them on the app record (`databricks apps update agent-portal --json @update-scopes.json`) **then stop/start the app**. The runtime mints user tokens from the scopes it booted with.
- Scope names are `<api-group>.<resource>`; bare names (`genie`, `unity-catalog`, ...) are rejected. Invoking agents needs `model-serving`.
- `DATABRICKS_HOST` arrives **without a scheme** in Apps; `dbx.host()` normalises it.
- `web/` is **committed** (it is what gets deployed) and `ui/out/` is gitignored. After any UI change, rebuild and copy to `web/` or the change will not ship.
- **New client / workspace:** set `PORTAL_LOG_TABLE` in `app.yaml` to `<existing catalog>.<schema>.portal_logs` (the only per-client line). The app creates the schema (`store.ensure_schema`, best effort) and both tables on first use and picks a warehouse itself unless `PORTAL_LOG_WAREHOUSE` pins one. The SP needs `USE CATALOG` + `CREATE SCHEMA` on the catalog (or `USE SCHEMA` + `CREATE TABLE` on an existing schema) and `CAN_USE` on a warehouse.
- **Onboarding an agent** = sharing its serving endpoint with the app's service principal (CAN_MANAGE). Until then it does not appear in the portal at all.

Environment variables (all optional): `PORTAL_LOG_TABLE`, `PORTAL_LOG_WAREHOUSE`, `PORTAL_CHAT_TABLE`, `PORTAL_CHAT_RETENTION_DAYS` (default 180), `DATABRICKS_CONFIG_PROFILE`, `DATABRICKS_WORKSPACE_ID`. `.env.local` holds local `DATABRICKS_HOST`/`DATABRICKS_TOKEN`; it is gitignored. Never print, log or commit its contents.

## Security model (do not weaken)

Two identities, used deliberately:

- **App service principal** (`dbx.app_token()`): metadata plane only. Reads endpoint ACLs, manages groups and tags, runs the Delta log/chat SQL.
- **Signed-in user's OBO token** (`X-Forwarded-Access-Token`, via `dbx.user_token()`): every agent invocation, file upload/download, and billing/audit query. Databricks then enforces endpoint ACLs and Unity Catalog itself, so a bug here can show a card but cannot widen access.

Rules:
- If no user token is forwarded in Apps, **fail closed (403)**. Never fall back to the service principal for invocation.
- `/api/chat`'s `_allowed_agent` pre-check is for clear errors only, not the security boundary.
- Admin routes go through `_require_admin` (membership in `admins`).
- Saved chats are filtered by the caller's user name taken from their token, never from a request field, and every value is a bound SQL parameter. That filter is the whole privacy boundary.
- Tokens and request bodies are never logged.
- Revoking access is a `PUT` of the surviving ACL entries and must **preserve service-principal grants**, or the portal locks itself out. Permission `PATCH` is additive.
- Local dev (no Apps runtime) uses the CLI token for both identities and the header badge says "local dev · your CLI identity".

## Features

### 1. Agent catalog and access (`access.py`)
- An agent is a serving endpoint with task `agent/*` (Responses, Chat). Endpoints tagged `portal=true` are also published. Embedding endpoints are excluded.
- Users see only agents they hold `CAN_QUERY`/`CAN_MANAGE` on (directly or via a group). `GET /api/agents`, `GET /api/session` (identity, `is_admin`, auth mode).
- Friendly names come from endpoint tags `display_name`, `blurb`; fallback is `_prettify`. Agent kinds (Multi-agent, Document expert, Agent, Chat model) are labelled for non-technical readers.
- Agent Bricks agents keep their real ACL at `/api/2.0/permissions/supervisor-agents/<agent_id>` (the `agent_id` tag), not on the endpoint. `perm_paths` handles both.

### 2. Chat (`chat.py`, `adapters.py`, `ui/components/Chat.tsx`)
- `POST /api/chat` runs under the user's token. Reply is normalised to `{reply, tools, citations, attachments}`.
- **Probe-and-learn protocol handling.** Endpoints disagree on the wire format (`input` for Responses vs `messages` for Chat/ChatCompletions). `adapters.build` dispatches on `task`; if the endpoint rejects the field (`wrong_field`), it switches once and `learn()`s the answer per endpoint. Agent Bricks serves no OpenAPI doc, so this cannot be discovered up front.
- **Shape-agnostic parsing** (`adapters.parse`): Responses `output[]`, ChatCompletions `choices[]`, ChatAgent `messages[]`, `final_response`/`result` wrappers, legacy `predictions`, `custom_outputs`, bare strings. Extracts text, tool names, citations, attachments.
- **SSE errors arrive as HTTP 200.** `chat._read` / `adapters.parse_sse` parse the stream and raise `AgentStreamError` on `event: error` (Genie-backed agents do this). Don't rely on status codes alone.
- **MCP approvals are auto-resolved.** A reply containing `mcp_approval_request` has not run the tool yet. `chat._resolve_approvals` replays the full prior turn plus `mcp_approval_response` items (the endpoint is stateless; `previous_response_id` is ignored).
- UI: markdown rendering, tool/citation display, copy, file attach, download of generated files, history panel.

### 3. Saved chat history (`chats.py`, `store.py`, `ui/components/ChatHistory.tsx`)
- Optional. Enabled by `PORTAL_CHAT_TABLE` (`catalog.schema.table`), else `portal_chats` beside `PORTAL_LOG_TABLE`; neither set = history off (`historyEnabled` false in UI).
- One append-only row per message, conversation = rows sharing a UUID, title = first question. Retention purge after `PORTAL_CHAT_RETENTION_DAYS`.
- Saved in a `BackgroundTask` after a successful reply only. Routes: `GET /api/chats`, `GET/DELETE /api/chats/{cid}`.

### 4. File-driven agents (`files.py`)
- Tag `upload_volume` (`catalog.schema.volume`) enables **Attach a file**; tag `accepts` (e.g. `xlsx, csv`) restricts types, enforced client and server. Max 100 MB.
- `POST /api/upload` writes to the UC volume **with the user's token**; the path is named in the turn so the agent reads it with its volume tool.
- Tag `output_volume` lets agents hand back generated files; `GET /api/download` is limited to paths inside that volume (`filestore.in_volume`).
- `sync_agents.py` auto-derives `upload_volume` from an agent's own `volume` tool.

### 5. Foundation models: removed
- The "General assistant" tab (raw `llm/v1/chat` foundation models, switched on by the `portal-llm-users` group, routes `/api/models` and `/api/admin/llm`) was removed. The portal only offers agents now.
- `llm.py` keeps only the billing code (`spend`, `_warehouse`, `_pretty_model`), used by Costs and the dashboards.

### 6. Admin console (`ui/components/Admin.tsx`, routes under `/api/admin/*`)
Sub-views: **People & access**, **Costs**, **Activity**, **Problems**, plus an Appearance panel.
- **People & access**: `GET /api/admin/overview`; `POST /api/admin/grant` (grant/revoke a user or group per agent), `POST /api/admin/group` (create a group "agent set"; also grants it app access), `POST /api/admin/group-members` (replaces the whole membership list, no incremental add/remove), `POST /api/admin/meta` (set tags: `display_name`, `blurb`, `upload_volume`, `accepts`, `output_volume`, `portal`; empty value deletes the tag).
- If the portal only has `CAN_VIEW`/`CAN_QUERY` on an agent, the admin sees a plain-English "not shared yet" note and controls are hidden.
- **Costs** (`llm.spend`, `GET /api/admin/cost`): queries `system.billing.usage` joined to `list_prices` for MODEL_SERVING, run as the admin. Degrades to a note if billing is unreadable. `CostChart.tsx` renders it.
- **Activity** (`audit.py`, `GET /api/admin/audit`): human sentences built from `system.access.audit` (e.g. "X gave Y permission to use Z"), with category filters and name lookups. Audit has ACL changes only; **conversations are not in it**.
- **Problems** (`logbuf.py`, `logsink.py`, `GET /api/admin/logs`): WARNING+ log lines. In-memory ring buffer (500 lines) by default; durable Delta table when `PORTAL_LOG_TABLE` is set (queued, batched, bounded to 1000, never logs its own failures).

### 7. Assistant builder (`builder.py`, `genie.py`, `knowledge.py`, `ui/components/Builder.tsx`, `GenieBuilder.tsx`, `KnowledgeBuilder.tsx`, `BuilderParts.tsx`)
Admin-only **Create an assistant** tab. It opens on a type picker ("Combine tools and information" = Supervisor Agent, "Answer questions from your documents" = Knowledge Assistant, "Answer questions from your data" = Genie space), then a step-by-step wizard. Both wizards share `BuilderParts.tsx` (step frame, access step, review section, done screen), so they look and behave identically. The Supervisor wizard has six steps (Name it, Instructions, Abilities, Files, Who can use it, Review; the access step is hidden when editing). It creates a real Agent Bricks **Supervisor Agent** (`/api/2.1/supervisor-agents`) so it also appears in Databricks.
- Tool kinds (`TOOL_TYPES`, max 20): UC function, Genie space, Knowledge Assistant, UC volume, MCP via UC connection, Databricks app (MCP), Vector Search index (**unconfirmed** shape, flagged in the UI).
- Routes: `/api/admin/builder/{types,sources,principals,agents}` plus `GET/PUT/DELETE .../agents/{id}`; `sources` browses catalogs/schemas/etc. for the pickers.
- **Identity fallback** (`builder.act`): try the admin's token first; retry as the app SP **only** when Databricks says the token lacks the `supervisor-agents` scope. Never retry other refusals. Admin is then given CAN_MANAGE; results include `acted_as`.
- Creation is all-or-nothing (a rejected tool deletes the half-built agent). Edit reconciles tools and leaves unmodelled tool types alone. Edit/delete require the admin to hold CAN_MANAGE on the agent.
- **Genie spaces** (`genie.py`, routes `/api/admin/builder/genie[/{id}]`, wizard `GenieBuilder.tsx`): choose a SQL warehouse and tables, add example questions and a note, pick who can use it, review. Stored as the `serialized_space` JSON (version 2; tables sorted by identifier, ids 32-hex). Editing round-trips the existing space and keeps everything the builder does not model (joins, SQL examples, benchmarks). Create uses the same `builder.act` fallback; **edit/delete/list use the admin's own token only, no fallback**, so Databricks decides. Sharing is CAN_RUN on `/api/2.0/permissions/genie/<id>`, applied immediately. Because the portal only chats with serving endpoints, a default-on option also creates a one-tool Supervisor Agent around the space (its access is applied by `finish_provisioning`); if that fails the space is kept and a warning says so. People also need `SELECT` on the tables, which the portal cannot grant, and the UI says so. `text_instructions` item shape is **unconfirmed** (not in the API reference's example).
- **Knowledge Assistants** (`knowledge.py`, routes `/api/admin/builder/knowledge[/{id}]`, wizard `KnowledgeBuilder.tsx`): name, description (required by Databricks), up to 10 document folders (each a UC volume path plus an optional subfolder, a name and a required "what is in it"), optional instructions, who can use it, review. Databricks only allows letters, numbers and dashes in the name, so the friendly name is stored in the endpoint's `display_name` tag and the Databricks name is derived from it (editable under Advanced). Only the "Files in a Volume" source type is offered. Create uses `builder.act` (the `knowledge-assistants` scope is expected to be refused for Apps user tokens, so the app identity usually does it) and is all-or-nothing: a rejected folder deletes the half-built assistant and the Databricks message is shown as it came. **Unconfirmed**, not in any reference this was built from: the `files.path` field carrying the volume path, the `knowledge-sources` sub-path and the `:sync` call (best effort, failure ignored). Edit changes name, description and instructions only; documents are shown read-only and changed in Databricks. Edit/delete use the admin's token with no fallback. Reading documents takes minutes, so `knowledge.finish` waits up to ~10 minutes for the endpoint, then hands over to `builder.finish_provisioning` with an **empty `agent_id`** (the supervisor-agents permission path is not a Knowledge Assistant's).
- `finish_provisioning` runs as a background task after create: waits for the endpoint (takes minutes), then tags it (name, description, `agent_id`, file tags) and shares it with the creator and portal; wizard-selected teams/people get CAN_QUERY through `access.set_grant`. If it times out, `python sync_agents.py --apply` finishes it.

### 8. Dashboards (`dashboard.py`, `ui/components/Dashboard.tsx`)
**My dashboard** tab for everyone: questions asked, conversations, assistants used, files sent/received, a questions-per-day chart and most-used assistants. Admins get a **Me / Everyone** switch: a ranked table of people, any one person's numbers, and an **estimated** cost per person.
- Source is the saved-chat table only (`chats.py`), so it needs history on and covers only chats since then; with history off the API returns `enabled: false` and the UI explains instead of showing zeros. Duplicate writes are removed (`QUALIFY ROW_NUMBER`).
- **Privacy:** `GET /api/dashboard/me` takes the user from the caller's token and ignores any `user` parameter. Admin routes (`/api/admin/dashboard/{people,person,costs}`) expose **counts only**, never question text or chat titles. Keep it that way.
- **Cost per person is an estimate**, not a bill: Databricks bills per endpoint, so each endpoint's real cost (`llm.spend`, run as the admin) is split by each person's share of questions to it. Cost with no portal usage behind it is shown as "Not from the portal", never spread over people. The UI labels it "Estimate" everywhere. Don't present it as exact.
- The SQL (`from_json` on the `meta` column for file counts, `count_if`) has not been run against a live warehouse.
- **Me** view (`Mine`): a sentence summary with Questions/Conversations (with deltas), Active days and Current streak (computed client-side from `per_day`); activity chart; "Your go-to assistants" with an **Ask** button (needs the `agents`, `onOpen`, `onResume` props from `page.tsx`; an assistant you lost access to shows "No access"); recent conversations (`api.chats("")`); a weekday x hour heatmap in the viewer's time zone; and "Your files" (sent and received, with Download only when the agent has `output_volume`, via `downloadUrl`). Extras come from `GET /api/dashboard/me/insights` (`dashboard.insights`: UTC hour buckets plus files parsed from message `meta`; received files that echo an upload in the same conversation, which Agent Bricks does, are dropped). Empty states: history off, brand-new user (suggested assistants), nothing in this period (offers 90 days).
- **Everyone** view adds `GET /api/admin/dashboard/overview` (`dashboard.org`): active and new people (with deltas), active people per day and questions per day as **two charts** (different scales, never a dual axis), an assistant leaderboard plus the assistants nobody used. Counts only. An admin's view of one person never shows their conversations, files or hours.
- The heatmap level classes (`heat-0..4`) live **outside** `@layer` in `globals.css`, because the class name is built at runtime and Tailwind would purge a layered rule.
- Headline numbers are one strip (`.kpi-strip`/`.kpi`) showing the change against the previous period of the same length (`previous` in the activity payload), as an arrow plus a signed number, never colour alone; a fall is neutral grey, not red. Questions gets a sparkline, and the chart an "Avg" reference line, only when at least 3 days have activity.
- Changing the period keeps the old numbers on screen dimmed (`usePeriod` + `Dim`) instead of flashing a skeleton. The admin People table sorts by any numeric column and pages 25 at a time. The empty state links to the assistants via the optional `onGoto` prop.

### 9. UI shell (`ui/app/page.tsx`)
Tabs (Radix, reflected in the URL hash): **Your assistants**, **My dashboard**, **Create an assistant** and **Admin** (admins only). Light / Dark / System theme (`ThemeToggle.tsx`, `?theme=` override, pre-paint script in `layout.tsx` to avoid flash). Colours are CSS variables in `globals.css`; use them rather than hard-coded colours.

The shell is a dark left sidebar (`.side*` classes, `--side-*` tokens, dark in both themes) holding the brand, a Search button, the tabs as a vertical `Tabs.List` (Workspace: Assistants, My dashboard; Manage: Create an assistant, Admin console), "Recent" conversations and the signed-in user. It folds to a 76px icon rail (remembered in `agent-portal-nav-collapsed`), is forced to the rail while a chat is open, and is a drawer on phones. A slim top bar (`.topbar`, breadcrumb, Search, theme toggle) sits over the content; its height is published as `--header-h` (ResizeObserver) and the chat sizes itself to the window below it, so don't hard-code it. `Tabs.Root` wraps everything so navigation works from inside a chat (picking a tab closes the chat). Tab values and URL hashes (`#dashboard`, `#build`, `#admin`) are unchanged.
- **Home** (`Home.tsx`): gradient banner (`.hero`) with greeting, search and live counts; "Pick up where you left off" from `api.chats("")` (history on only); kind filter chips; `AgentCard` grid. `kindMeta` in `AgentCard.tsx` gives each kind one label, icon and colour (`.kind-*`).
- **Recent conversations** open via `Chat`'s optional `resumeId` prop, which calls its own `resume` after the reset effect.
- **Quick switcher** (`QuickSwitcher.tsx`, Ctrl/Cmd+K): jump to any ready assistant or page; navigation only.
Shared look: `.seg`, `.chip`, `.avatar`, `.filter-chip`, `.cap`, `.status-pill`, `--shadow` tokens, all in `globals.css`; `lib/people.ts` has `initials`/`nameOf`.

### 10. Observability
Every request gets an access-log line via middleware (caller from `x-forwarded-email`, status, timing). `DbxError` is mapped to the upstream status by an exception handler. `/api/health` returns `{ok, auth_mode}`. Interactive API docs at `/api/docs`.

## Layout

```
app.py           FastAPI routes, admin guard, access-log middleware; mounts web/ last
dbx.py           dual-mode auth (local CLI / Apps OBO), host(), call(), DbxError
access.py        catalog, effective permissions, grants, groups, tags
chat.py          invocation; JSON + SSE parsing; MCP approval replay
adapters.py      per-protocol request shapes, probe-and-learn, reply parsing
chats.py         per-user saved conversations (Delta)
store.py         run SQL as the app identity (warehouse selection)
logsink.py       durable problem log (Delta)   logbuf.py  in-memory log ring
files.py         UC volume upload / download
llm.py           real model-serving spend (system.billing)
audit.py         activity log from system.access.audit
builder.py       Supervisor Agent create/edit/delete
knowledge.py     Knowledge Assistant create/edit/delete (document folders as sources)
genie.py         Genie space create/edit/delete + sharing (+ optional chat wrapper)
dashboard.py     per-person activity and estimated cost, from the chat table
sync_agents.py   CLI: Agent Bricks metadata -> endpoint tags
test_adapters.py, test_builder.py, test_genie.py, test_knowledge.py, test_dashboard.py, smoke.sh   tests
ui/              Next.js 14 + React 18 + Tailwind 3 + Radix Tabs + react-markdown (components/, lib/api.ts)
web/             built static export that FastAPI serves (committed)
app.yaml, update-scopes.json   Databricks Apps manifest and user-API scopes
```

`../weather_supervisor_agent.py` and `../weather_uc_functions.sql` (one level up, untracked) are a standalone example: a hand-built LangGraph/MLflow "supervisor" agent over two Unity Catalog weather functions. They are not part of the portal.

## Conventions

- Python 3, `from __future__ import annotations`, httpx for all HTTP, route handlers stay thin and delegate to modules. Module docstrings explain *why* (verified Databricks behaviour); keep that style and record new findings there rather than in commit messages.
- Calls to Databricks go through `dbx.call` and raise `DbxError(message, status)`; routes mirror the status. Use the quiet option for expected failures so they don't pollute the Problems log.
- All SQL uses bound parameters; identifiers (table names) are validated against `_NAME_RE` before use.
- The UI talks to the backend only through the typed wrapper in `ui/lib/api.ts`; add new endpoints there. Copy is written for non-technical readers: plain English, no Databricks jargon in user-facing text.
- Next.js is pinned exactly (`output: "export"`, no server features such as API routes, SSR or middleware).
- Don't claim Supervisor Agent, Genie or Knowledge Assistant builder behaviour is verified live; shapes come from the API references and the Databricks create screen (see README).

## Known gaps

- Data-backed agents also need Unity Catalog grants (`USE CATALOG`/`USE SCHEMA`/`SELECT`) for the end user; the portal reports the failure but cannot fix it.
- Only Supervisor Agents, Genie spaces and Knowledge Assistants can be built; custom agents, MCP servers and UC connections are created in Databricks and only *attached* here. Knowledge Assistant sources other than volume folders (search index, table of files) are not offered.
- Group membership edits replace the whole list.
- Dashboards need saved chat history and only cover chats since it was turned on; per-person cost is an allocation estimate.
- Uploads are named by path in the message, not via Agent Bricks' own "Conversation Files" (no public API).
- Some README sections predate chat history and the activity/problem logs (e.g. "No chat history" under Known V1 gaps); trust this file and the code.
