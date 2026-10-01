# Agent Portal — V1 PoC

A friendly front door to Databricks agents, for people who will never open a Databricks
workspace.

- **End users** sign in, see only the agents they are allowed to use, and chat with them.
- **Admins** grant that access from the UI, using Databricks groups as reusable "agent sets".

Everything is Databricks behind the scenes. The portal stores **nothing** of its own — delete
it and rebuild it and no configuration is lost.

## Where state actually lives

| Concept | Databricks-native home |
| --- | --- |
| What an agent *is* | a serving endpoint with `task = agent/v1/responses` |
| Friendly name / description | endpoint **tags** (`display_name`, `blurb`) |
| Who may use it | the endpoint's own **ACL** (`CAN_QUERY`) |
| An "agent set" | a workspace **group** named in those ACLs |
| Enforcement | the signed-in user's **OBO token** at invoke time |

## Handling every kind of agent

Databricks lets people build agents in many shapes — Supervisor Agent, Knowledge Assistant,
"code your own" via Agent Framework, plus the structured/unstructured builders — and the
resulting endpoints **do not speak one protocol**. Verified on this workspace:

| task | request field | response shape |
| --- | --- | --- |
| `agent/v1/responses` | `input` | Responses API — `output[]` |
| `agent/v1/chat` | `messages` | ChatAgent — `messages[]` or `choices[]` |
| `llm/v1/chat` | `messages` | ChatCompletions — `choices[]` |

The formats are mutually exclusive and strictly enforced: sending `messages` to a Responses
agent returns `400 "'messages' field is not supported. Please use 'input' field instead."`
And Agent Bricks agents serve **no OpenAPI document**, so the schema cannot be discovered up
front.

So `adapters.py` does two things:

1. **Dispatches on `task`** where the format is known.
2. **Probes and learns** where it is not — it sends a shape, reads the rejection, switches
   once, and remembers the answer per endpoint. This is verified against a live endpoint: the
   test declares the wrong task, the first call fails, and the reply still arrives.

That second behaviour is what lets the portal front an agent type that did not exist when
this code was written.

Reply parsing is deliberately shape-agnostic rather than trusting the declared task, because
a "code your own agent" deployment returns whatever schema its author chose. `adapters.parse`
harvests assistant text, tool names, citations and attachments from all of: Responses
`output[]`, ChatCompletions `choices[]`, ChatAgent `messages[]`, a `final_response` /
`result` wrapper (what Agent Bricks supervisors actually return), legacy MLflow
`predictions`, `custom_outputs`, and a bare string. `test_adapters.py` covers 17 cases,
including the two real payloads captured from this workspace.

**Per-agent capabilities are declared in endpoint tags**, so the portal still stores nothing:

| tag | effect |
| --- | --- |
| `display_name`, `blurb` | what an end user sees instead of `mas-0062ab3f-endpoint` |
| `upload_volume` | `catalog.schema.volume` — enables the Attach-a-file control |
| `accepts` | e.g. `xlsx, csv` — client and server both enforce it |
| `portal` | `true` publishes a non-`agent/*` endpoint (a custom deployment) as an agent |

An admin sets all of these from the UI. Setting a tag to empty deletes it, so a capability
can be withdrawn.

### Foundation models as chat assistants

All 21 `llm/v1/chat` foundation models are offered as plain chat assistants, in a **separate
collapsed section** so they cannot drown the handful of purpose-built agents. Embedding
endpoints are excluded — they are not conversational.

Three facts forced a different design from agents, all verified rather than assumed:

1. **Foundation models have no endpoint `id`.** `GET /serving-endpoints/databricks-claude-sonnet-5`
   returns no id, so `/api/2.0/permissions/serving-endpoints/<id>` cannot be addressed —
   Databricks offers **no per-user ACL** for them.
2. **They cannot be tagged** (404 `RESOURCE_DOES_NOT_EXIST`), so the tag mechanism used for
   agent capabilities is unavailable.
3. **They cost real money per token.**

So the switch cannot live in permissions or tags. It lives in a **workspace group**,
`portal-llm-users`: the group's existence is the on/off state and its membership is the
audience. The portal still stores nothing of its own, the switch reuses the same group
mechanism as agent sets, it is visible and auditable in the Databricks admin UI, and it
**fails closed** — no group, no models. Default is off.

> **This is curation, not security.** Any workspace user whose token carries the
> `model-serving` scope can call these models directly outside the portal, and Databricks
> provides no way to prevent that per user. The switch decides what the portal offers, and
> therefore what casual users actually spend. The admin UI says exactly this on screen.

### What it costs — real numbers, not estimates

The admin console reads the workspace's **own billing tables** rather than quoting a price
list, so the answer to "does this cost money?" is a number:

```sql
SELECT u.sku_name, SUM(u.usage_quantity) AS dbus,
       SUM(u.usage_quantity * p.pricing.default) AS usd
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices p
       ON p.sku_name = u.sku_name AND p.price_end_time IS NULL
WHERE u.billing_origin_product = 'MODEL_SERVING' AND u.usage_date >= date_sub(current_date(), 30)
GROUP BY u.sku_name
```

On this workspace that currently reports **60.25 DBUs = $6.33 over 30 days**
(`PREMIUM_ANTHROPIC_MODEL_SERVING` at $0.105/DBU). The query runs as the signed-in admin,
because `system.billing` is granted to people rather than to the app, and it degrades to a
note rather than an error if billing is unreadable — a cost panel that cannot load must not
break the console.

The per-model "lower cost / higher cost" badge is only a hint from the model name; the panel
above is the truth.

### File-driven agents

Some agents exist to process a document — the mid-campaign reporter wants one `.xlsx` and
does nothing without it. A browser upload is invisible to an agent, so `files.py` writes the
file to the agent's declared Unity Catalog volume **using the user's own token** (so UC
decides whether they may write there), and the resulting path is named in the turn. The agent
then reads it with its own volume tool.

Known limits: foundation-model endpoints cannot be tagged at all (they are system-owned, and
the tags API reports them as non-existent), so `portal=true` applies only to endpoints your
own workspace deploys. And the portal names the uploaded path in the message rather than
using Agent Bricks' own "Conversation Files" mechanism, which is not exposed by a public API.

## The security model, in one paragraph

Two identities are used deliberately. The **app's service principal** reads endpoint ACLs and
manages groups — the metadata plane only. Every **agent invocation** goes out under the
signed-in user's own token, so the endpoint ACL and Unity Catalog are enforced by Databricks
itself. That means a bug in this app cannot widen access: the worst it can do is show a card
the user then cannot use. The pre-flight check in `/api/chat` exists only to produce a clearer
error message, not as the security boundary.

If the Apps runtime does not forward a user token, the portal **fails closed** (HTTP 403)
rather than falling back to the service principal — that fallback would silently turn every
user into the app identity.

## Run locally

```bash
pip install -r requirements.txt
export DATABRICKS_CONFIG_PROFILE=azure-prem
python -m uvicorn app:app --port 8811
# open http://127.0.0.1:8811   (#admin opens the access console)
```

With no Apps runtime present, both identities fall back to your CLI token and the header
badge reads **"local dev · your CLI identity"** so this is never mistaken for real OBO.

## Deployed

Live at **https://agent-portal-7405615965667597.17.azure.databricksapps.com**
(app SP `26d3ef32-e56e-473f-a526-45a4ff712c9d`). `./smoke.sh <url>` passes 14/14 against it,
including a real agent invocation under a genuine forwarded user token.

## Deploy from scratch

```bash
P=azure-prem
U=$(databricks current-user me -p $P -o json | python -c "import sys,json;print(json.load(sys.stdin)['userName'])")

databricks apps create agent-portal -p $P
databricks workspace import-dir . "/Users/$U/agent-portal" --overwrite -p $P
databricks apps deploy agent-portal --source-code-path "/Workspace/Users/$U/agent-portal" -p $P

# Scopes are NOT applied from app.yaml. Put them on the app record...
databricks apps update agent-portal --json @update-scopes.json -p $P
# ...then RESTART, or the runtime keeps minting tokens with the old scopes.
databricks apps stop agent-portal -p $P && databricks apps start agent-portal -p $P
databricks apps get agent-portal -o json -p $P   # -> effective_user_api_scopes
```

Four things this sequence encodes, each of which cost a debugging cycle:

1. **`DATABRICKS_HOST` arrives without a scheme** in the Apps runtime (a bare hostname), while
   the CLI profile supplies a full URL. `dbx.host()` normalises both, or httpx rejects every
   request for a missing protocol.
2. **Scope names are `<api-group>.<resource>`.** Bare names are mostly rejected as invalid —
   `unity-catalog`, `genie`, and `model-serving-inference` are *not* valid, though
   `model-serving` is. `iam.current-user:read` and `iam.access-control:read` are granted by
   default and cannot be requested.
3. **Invoking an agent needs `model-serving`.** `serving.serving-endpoints` only covers the
   management APIs; without `model-serving` the invocation fails with *"Provided OAuth token
   does not have required scopes: model-serving, model-serving-inference"*.
4. **Changing scopes requires an app restart.** The runtime mints OBO tokens from the scope
   set it booted with, so a scope change is invisible until compute is cycled.

## Onboarding an agent — the one manual step

Agent endpoints **do not** grant workspace admins implicit `CAN_MANAGE`, and
`GET /api/2.0/serving-endpoints` **filters by permission**. So an agent the portal has not been
given access to does not appear in the portal at all. Sharing an agent with the portal's
service principal *is* the act of onboarding it:

```bash
databricks permissions update serving-endpoints <endpoint-id> -p azure-prem --json '{
  "access_control_list": [
    {"service_principal_name": "<app-sp-client-id>", "permission_level": "CAN_MANAGE"}
  ]
}'
```

This is the honest cost of "native ACLs only" — there is no workspace-wide "manage all
endpoints" grant to lean on. It is also a useful property: the portal's catalog is exactly the
set of agents deliberately published to it, and nothing leaks in by default. If the portal is
given only `CAN_VIEW`/`CAN_QUERY` rather than `CAN_MANAGE`, the agent is listed in the admin
console with a plain-English note that it has not been shared yet, and its controls are hidden.

## Layout

```
app.py          FastAPI routes + admin guard
dbx.py          auth (dual mode: local CLI / Apps OBO) and HTTP plumbing
access.py       agent catalog, effective-permission resolution, grants
chat.py         invocation; parses BOTH JSON and SSE replies
adapters.py     one transport shape per agent protocol, with probe-and-learn
llm.py          foundation models, the on/off switch, real spend
files.py        uploads for file-driven agents
builder.py      create/edit Supervisor Agents and attach tools (admin-only routes)
sync_agents.py  pulls agent names/settings out of Databricks into tags
ui/             Next.js 14 + React 18 + Tailwind 3 (see ui/README.md)
web/            built static export of ui/ - this is what FastAPI serves
app.yaml        Databricks Apps manifest
```

The UI is a **static export**, because Databricks Apps runs one command and
that command is uvicorn. `web/` is mounted at `/` after every `/api/*` route,
so the API keeps priority. Rebuild with:

```bash
cd ui && npm install && npm run build && cp -r out ../web
```

## Building Supervisor Agents

Admins get a **Create an assistant** tab, a guided step-by-step flow (name, instructions, abilities, files, who can use it, review). It creates a real Agent Bricks Supervisor Agent
(`/api/2.1/supervisor-agents`), so it also shows in the workspace's own Agents page and the
portal still stores nothing. An admin sets the name, description and instructions (system
prompt), and attaches tools: Unity Catalog functions, Genie spaces, Knowledge Assistants,
volumes, MCP servers (UC connections and Databricks apps), and Vector Search indexes.
Editing reconciles tools (add / remove / re-describe) and leaves tools added in Databricks
with a type the builder does not model untouched. Creation is all-or-nothing: if a tool is
rejected the half-built agent is deleted.

**Identity.** The API needs the `supervisor-agents` scope, which an Apps user token cannot
hold. The admin's own token is tried first (works locally); only if Databricks says the token
lacks the scope is the call retried as the app's service principal, and the admin is then
given CAN_MANAGE on the agent. Any other refusal (a real permission error, or a plan that
does not include Supervisor Agents) is shown, never retried. Every result says which identity
did the work. Edits and deletes still require the admin to hold CAN_MANAGE on that agent.

**Unverified against a live workspace:** the Supervisor Agent API is Beta and its tool shapes
are taken from the API reference, not exercised here. Vector Search is the one tool type whose
nested field is undocumented, so it is flagged in the UI. Run `python test_builder.py` for the
offline tests; the first real create is the live check.

Teams and people chosen in the wizard get CAN_QUERY through the same `access.set_grant`
the Manage access screen uses. Because the serving endpoint does not exist yet, this is
applied by the same background task below, one grant at a time (a bad name is logged and does
not stop the others). When editing an existing assistant the step is hidden: use
Admin > People & access, which shows the current list.

After creation the serving endpoint takes a few minutes to appear. A background task then tags
it (name, description, `agent_id`) and puts the creator and portal on its ACL. If that times
out, `python sync_agents.py --apply` finishes the job.

### Data assistants (Genie spaces)

The type picker's second option creates a Genie space (`genie.py`): SQL warehouse, tables,
example questions and a note, stored in the documented `serialized_space` JSON. Editing keeps
whatever the builder does not model. Create may fall back to the app identity on a missing scope
(like supervisors); edit and delete use the admin's own token only. Chosen teams and people get
CAN_RUN on the space straight away. Since the portal chats only with serving endpoints, a
default-on option also creates a small supervisor around the space so it appears under Your
assistants. People still need `SELECT` on the tables, which the portal cannot grant. Not yet
exercised against a live workspace; the `text_instructions` item shape is the one part the
reference does not show. `python test_genie.py` runs the offline tests.

### Document assistants (Knowledge Assistants)

The type picker's third option creates a Knowledge Assistant (`knowledge.py`): a name and
description, up to ten folders of documents (each with a description of what is in it), optional
instructions, and who can use it. The Databricks name allows only letters, numbers and dashes, so
the friendly name is kept in a tag and the Databricks name is derived from it. Only "Files in a
Volume" sources are offered. Creation is all-or-nothing and shows Databricks' own message if it
refuses something. **Not yet run against a live workspace**: the field that carries a folder path
(`files.path`), the sources sub-path and the sync call are not in the API reference, so the first
real create is the check. Editing changes the name, description and instructions; documents are
changed in Databricks. Reading the documents takes minutes, so the assistant appears under Your
assistants (with its access) once its endpoint exists. `python test_knowledge.py` runs the
offline tests.

## Dashboards

**My dashboard** shows each person their own activity (questions, conversations, assistants used,
files in and out, questions per day). Admins also get **Everyone**: a ranked table of people, any
one person's numbers, and an estimated cost per person. It is built entirely from the saved chat
history, so it needs `PORTAL_CHAT_TABLE` (or the log table beside it) and only counts chats since
that was switched on. Admins see counts only, never what anyone asked. Cost per person is an
estimate: Databricks bills per assistant, so each assistant's real cost is shared by each person's
share of questions to it, and spend with no portal use behind it is shown separately. Not yet run
against a live warehouse. `python test_dashboard.py` runs the offline tests.

## Two traps this PoC already handles

1. **SSE errors arrive as HTTP 200.** A Genie-backed agent answers `event: error` inside a
   200 stream. Status-code checking alone yields a blank reply; `chat.py` parses the stream
   and surfaces the real message.
2. **`permissions update` is additive (PATCH).** A revoke is therefore a `PUT` of the
   surviving entries — and it deliberately preserves service-principal grants, or the portal
   would lock itself out of the endpoint it is managing.

## Known V1 gaps

- **No chat history.** Conversations live in the browser tab and vanish on reload. Persisting
  them needs a real store, which is the first thing that breaks "no database".
- **Data-backed agents need Unity Catalog grants too.** `CAN_QUERY` on the endpoint is not
  enough for a Genie-backed agent; the *end user* also needs `USE CATALOG` / `USE SCHEMA` /
  `SELECT`. The portal reports the failure clearly but cannot fix it — surfacing UC grants in
  the admin UI is the natural V1.1.
- **Only Supervisor Agents, Genie spaces and Knowledge Assistants can be built here** (see below). Knowledge Assistants, custom
  Agent Framework agents, MCP servers and UC connections are still created in Databricks - the
  builder can *attach* them, not make them.
- Group membership is set by replacing the whole list; there is no incremental add/remove yet.
