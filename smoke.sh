#!/usr/bin/env bash
# End-to-end smoke test against a running portal.
#   python -m uvicorn app:app --port 8811   # in another shell
#   ./smoke.sh
# Hits the real workspace, so "real chat reply" costs one agent invocation.
#
# Against a deployed Databricks App, pass its URL - the Apps proxy requires a
# bearer token, which is picked up from DATABRICKS_CONFIG_PROFILE:
#   ./smoke.sh https://agent-portal-<id>.<region>.azure.databricksapps.com
set -u
B="${1:-http://127.0.0.1:8811}"
J='Content-Type: application/json'
P=0
F=0

AUTH=()
case "$B" in
  https://*databricksapps.com*)
    tok=$(databricks auth token --profile "${DATABRICKS_CONFIG_PROFILE:-azure-prem}" -o json \
          | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
    AUTH=(-H "Authorization: Bearer $tok")
    ;;
esac

run() { # name, expected-substring, curl args...
  local n="$1" want="$2"; shift 2
  local out
  out=$(curl -s --max-time 240 "${AUTH[@]+"${AUTH[@]}"}" "$@" 2>&1)
  if echo "$out" | grep -qi -- "$want"; then
    echo "  PASS  $n"; P=$((P + 1))
  else
    echo "  FAIL  $n  (wanted '$want', got: $(echo "$out" | head -c 140))"; F=$((F + 1))
  fi
}

echo "--- agent portal smoke test against $B ---"

# plumbing and identity
run "health"              '"ok":true'          "$B/api/health"
run "session identity"    'is_admin'           "$B/api/session"

# catalog. task and kind must be present: task drives the wire format the
# adapter picks, kind drives the badge an end user sees.
run "catalog lists"       'display_name'       "$B/api/agents"
run "access reason shown" 'access_reason'      "$B/api/agents"
run "task exposed"        'task'               "$B/api/agents"
run "kind exposed"        'kind_label'         "$B/api/agents"
run "file capability flag" 'supports_files'    "$B/api/agents"

# foundation models. The switch is a Databricks group, so these reflect real
# workspace state: "enabled" tells you whether portal-llm-users exists.
run "models endpoint"     'enabled'            "$B/api/models"
run "llm switch state"    'portal-llm-users'   "$B/api/admin/llm"
run "cost panel"          'available'          "$B/api/admin/cost?days=7"
# Activity log reads Databricks' own audit records and renders them as
# sentences; check the endpoint answers and that filtering is honoured.
run "activity log"        'events'             "$B/api/admin/audit?days=7&cats=access"
run "activity filters"    'available'          "$B/api/admin/audit?days=1&cats=admin"

# The admin console must not lend the app's CAN_MANAGE to its users. An
# unreadable endpoint id proves the gate exists without depending on who
# happens to manage what today.
run "manage gate on writes" 'Manage permission' -X POST "$B/api/admin/grant" -H "$J"   -d '{"endpoint_id":"0000000000000000000000000000dead","kind":"group","principal":"users","level":"CAN_QUERY"}'
run "manage gate on rename" 'no such agent' -X POST "$B/api/admin/meta" -H "$J"   -d '{"name":"definitely-not-an-agent","display_name":"x"}'

# upload is refused unless an admin declared a destination volume
run "upload needs a volume" 'does not accept file' -X POST "$B/api/upload" \
  -F "endpoint=mas-0062ab3f-endpoint" -F "file=@smoke.sh"
run "upload guards access"  'do not have access'   -X POST "$B/api/upload" \
  -F "endpoint=no-such-agent-xyz" -F "file=@smoke.sh"

# admin console. Note the agent list is scoped to what the *app's* service
# principal can see - GET /serving-endpoints filters by permission - so an
# agent not yet shared with the portal is absent entirely rather than listed
# as unmanageable. Do not assert on the unshared-agent message here.
run "admin overview"      'manageable'         "$B/api/admin/overview"
run "admin lists groups"  'groups'             "$B/api/admin/overview"
run "admin lists users"   'users'              "$B/api/admin/overview"

# static assets
# The UI is a Next.js static export served by FastAPI. Check the shell renders
# and that its hashed asset paths actually resolve.
run "ui shell served"    '_next/static'      "$B/"
run "ui title"           'Agent Portal'      "$B/"
# The theme boot script must be inline in the shell, or a viewer who chose
# Light gets a flash of dark before React hydrates.
run "theme boot inline"  'data-theme'         "$B/"

# access enforcement and input validation
# A real agent name would make this depend on who shared what today.
run "guard: unshared agent" 'do not have access' -X POST "$B/api/chat" -H "$J" \
  -d '{"endpoint":"definitely-not-an-agent","history":[{"role":"user","content":"hi"}]}'
run "guard: unknown name" 'do not have access' -X POST "$B/api/chat" -H "$J" \
  -d '{"endpoint":"nope","history":[{"role":"user","content":"hi"}]}'
run "validate: no endpoint" 'required'         -X POST "$B/api/chat" -H "$J" \
  -d '{"endpoint":"","history":[]}'

# the real thing
run "real chat reply"     'reply'              -X POST "$B/api/chat" -H "$J" \
  -d '{"endpoint":"mas-0062ab3f-endpoint","history":[{"role":"user","content":"Reply with the single word OK."}]}'

echo "--- $P passed, $F failed ---"
[ "$F" -eq 0 ] || exit 1
