// Thin wrapper over the portal's existing FastAPI routes. The backend is
// unchanged - this rewrite is UI only - so every path here already exists.

export type Agent = {
  name: string;
  id: string | null;
  task: string;
  kind: string;
  kind_label: string;
  kind_hint: string;
  display_name: string;
  blurb: string;
  ready: boolean;
  state: string;
  upload_volume: string;
  output_volume: string;
  accepts: string[];
  supports_files: boolean;
  access_reason?: string;
  metered?: boolean;
  light?: boolean;
};

export type Session = {
  user_name: string;
  display_name: string;
  groups: string[];
  is_admin: boolean;
  auth_mode: string;
  chat_history: boolean;
  /** The release this portal runs (set by the deployer); empty in a checkout. */
  version?: string;
  /** The client's branding (deployer); empty strings when unbranded. */
  brand?: { name: string; color: string; logo: string };
};

export type Grant = {
  principal: string;
  kind: string;
  level: string;
  inherited: boolean;
};

export type AdminAgent = Agent & {
  grants: Grant[];
  acl_error: string | null;
  manageable: boolean;
  you_can_manage?: boolean;
  agent_id?: string;
};

export type ToolType = { type: string; label: string; confirmed: boolean };
export type SourceItem = { value: string; label: string; detail: string };
export type McpState = "not_deployed" | "deploying" | "running" | "stopped" | "failed";
export type McpEntry = {
  slug: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  app_name: string;
  tools: { name: string; description: string; changes_data: boolean }[];
  needs: { secrets: string[]; volumes: string[] };
  problem: string;
  state: McpState;
  state_note: string;
  url: string;
};
export type BuilderTool = {
  type: string;
  ref: string;
  description: string;
  tool_id?: string;
  readonly?: boolean;
  /** Folder name of a catalog tool the person ticked; the server decides whether it needs deploying. */
  mcp?: string;
};
export type DesignerKind = "supervisor" | "genie" | "knowledge";
/** A tool the designer proposes to create. `fingerprint` is what an approval is tied to. */
export type DesignerNewTool = {
  kind: "uc_function" | "mcp";
  name: string;
  slug?: string;
  description: string;
  sql?: string;
  example?: string;
  code?: string;
  abilities?: { name: string; description: string; changes_data: boolean }[];
  hosts?: string[];
  secrets?: string[];
  volumes?: { volume: string; access: "read" | "write" }[];
  problems: string[];
  fingerprint: string;
  report: {
    kind: "uc_function" | "mcp";
    hosts?: string[];
    settings?: string[];
    folders?: { volume: string; access: string }[];
    reads_files?: boolean;
    saves_files?: boolean;
    calls_internet?: boolean;
    may_change_outside?: boolean;
    packages?: string[];
    lines?: number;
  };
};
export type DesignerToolResult = {
  key: string;
  kind: "uc_function" | "mcp";
  created?: boolean;
  started?: boolean;
  app_name?: string;
  example?: string;
  example_result?: unknown[][] | null;
  example_error?: string;
  error?: string;
};
/** What the interview has worked out so far. Same shape the three builders take. */
export type DesignerDraft = {
  kind?: DesignerKind;
  display_name?: string;
  description?: string;
  instructions?: string;
  tools?: { type: string; ref: string; description: string; mcp?: string }[];
  files?: { upload_volume: string; output_volume: string; accepts: string };
  warehouse_id?: string;
  tables?: string[];
  sample_questions?: string[];
  notes?: string;
  sources?: { volume: string; subfolder: string; name: string; description: string }[];
  access?: { kind: "group" | "user"; principal: string }[];
  access_decided?: boolean;
  chat?: boolean;
  gaps?: string[];
  /** Each thing asked for, checked against what the tools really do. */
  coverage?: { need: string; status: "covered" | "partly" | "missing"; by?: string; note?: string }[];
  /** Tools to create before the assistant is built; the admin reads them first. */
  new_tools?: DesignerNewTool[];
};
/** What was shown for a message; `looked` is only for display and is never sent back. */
export type DesignerMessage = { role: "user" | "assistant"; content: string; options?: string[]; looked?: string[] };
/** A chat model this admin can use. `fit` says honestly how well it is known to suit the designer. */
export type DesignerModel = {
  name: string;
  label: string;
  kind: "hosted" | "external" | "custom";
  maker: string;
  recommended: boolean;
  /** False = it cannot call functions, which the interview needs. null = not reported. */
  tools: boolean | null;
  /** Real prices from the workspace, in DBUs per million tokens (null when not reported). */
  price_in: number | null;
  price_out: number | null;
  /** "Low cost" / "Moderate cost" / "Higher cost", from the real price. */
  cost: string;
  detail: string;
  fit: string;
  /** What it is good at, e.g. "Balanced: a good default" ("" when unknown). */
  tier?: string;
};
/** The three jobs a model can do. Empty = let the portal choose. */
export type DesignerModels = { chat: string; code: string; judge: string };
export type DesignerInfo = {
  enabled: boolean;
  ready: boolean;
  reason: string;
  models: DesignerModel[];
  defaults: DesignerModels;
};
export type DesignerStep = { key: string; label: string; done: boolean };
export type DesignerTurn = {
  reply: string;
  options: string[];
  multiple: boolean;
  draft: DesignerDraft;
  ready: boolean;
  problems: string[];
  kind_label: string;
  /** The checklist in plain words (what is settled, what is not). */
  progress: DesignerStep[];
  /** What it looked at to answer, e.g. "your tables". */
  looked: string[];
  /** The models actually used, after defaults. */
  models: DesignerModels;
  /** Said when a model had to be swapped (for example one Databricks has retired). */
  notice: string;
  /** Said when the model answered without looking at anything (so it may miss what you already have). */
  warning: string;
};
export type DesignerTest = { question: string; expect: string; type: "typical" | "edge" | "out_of_scope" };
export type DesignerResult = {
  verdict: "pass" | "fail" | "ungraded";
  reason: string;
  answer: string;
  tools?: string[];
};
/** One call to try a new tool with, and what came back. */
export type ToolTest = { ability: string; arguments: Record<string, unknown>; expect: string; expect_error: boolean };
export type ToolResult = {
  /** pass / fail (crashed, or refused a realistic call) / look (worth a glance) / unchecked (the test said nothing about the tool) */
  verdict: "pass" | "fail" | "look" | "unchecked";
  kind: string;
  reason: string;
  ability: string;
  arguments: Record<string, unknown>;
  expect_error: boolean;
  preview: string;
};
export type ToolPlan = { tests: ToolTest[]; skipped: { ability: string; why: string }[]; notice: string };
/** A repair the code model proposes. Nothing is installed until it has been read and approved. */
export type ToolFix = {
  slug: string;
  name: string;
  code: string;
  what: string;
  diff: string[];
  fingerprint: string;
  problems: string[];
  no_change: boolean;
  notice: string;
};
export type DesignerBuilt = {
  kind: DesignerKind;
  name: string;
  endpoint_name?: string;
  warnings?: string[];
  deploying?: string[];
  access_pending?: number;
  chat?: boolean;
};
export type FileSettings = { upload_volume: string; output_volume: string; accepts: string };
export type BuilderAgent = {
  agent_id: string;
  display_name: string;
  description: string;
  instructions: string;
  endpoint_name: string;
  tools: BuilderTool[];
  files: FileSettings;
  acted_as?: string;
};
export type BuilderSpec = {
  display_name: string;
  description: string;
  instructions: string;
  tools: { type: string; ref: string; description: string; mcp?: string }[];
  files: FileSettings;
  access: { kind: "group" | "user"; principal: string }[];
};

export type GenieSpec = {
  title: string;
  description: string;
  warehouse_id: string;
  tables: string[];
  sample_questions: string[];
  notes: string;
  access: { kind: "group" | "user"; principal: string }[];
  chat: boolean;
};
export type GenieSpace = Omit<GenieSpec, "access" | "chat"> & { space_id: string; etag: string };

export type Activity = {
  enabled: boolean;
  days: number;
  note: string;
  questions: number;
  conversations: number;
  assistants: number;
  files_sent: number;
  files_back: number;
  last_active: string;
  previous?: { questions: number; conversations: number };
  per_day: { day: string; questions: number }[];
  top_assistants: { name: string; label: string; questions: number; last_used: string }[];
};
export type PersonRow = {
  user: string;
  questions: number;
  conversations: number;
  assistants: number;
  last_active: string;
};
export type CostRow = { user: string; est_usd: number; questions: number };
export type FileItem = {
  direction: "sent" | "received";
  name: string;
  path: string;
  endpoint: string;
  label: string;
  at: string;
  conversation_id: string;
};
export type Insights = {
  enabled: boolean;
  days: number;
  note: string;
  /** UTC hour buckets ("2026-10-01T09:00:00Z") with questions asked in each. */
  hours: { hour: string; questions: number }[];
  files: FileItem[];
};
export type PortalEvent = {
  at: string;
  actor: string;
  action: string;
  category: string;
  target: string;
  label: string;
  /** "ok", "error", or "tool_error" (the reply came back but a tool inside it failed). */
  status: string;
  http_status: number;
  ms: number;
  error_kind: string;
  error: string;
  detail: Record<string, any>;
};
export type ActivityFeed = {
  stored: boolean;
  days: number;
  total: number;
  people: number;
  failed: number;
  categories: Record<string, number>;
  events: PortalEvent[];
};
export type AgentHealthRow = {
  endpoint: string;
  label: string;
  questions: number;
  failed: number;
  tool_errors: number;
  failure_rate: number;
  avg_ms: number;
  p90_ms: number;
  people: number;
  last_problem: { at: string; kind: string; error: string } | null;
};
export type HealthReport = {
  stored: boolean;
  days: number;
  questions: number;
  failed: number;
  tool_errors: number;
  avg_ms: number;
  kinds: { kind: string; label: string; count: number }[];
  agents: AgentHealthRow[];
  recent: PortalEvent[];
};
export type OrgOverview = {
  enabled: boolean;
  days: number;
  note: string;
  people: number;
  questions: number;
  conversations: number;
  assistants: number;
  new_people: number;
  previous: { people: number; questions: number };
  per_day: { day: string; questions: number; people: number }[];
  assistants_used: { name: string; label: string; questions: number; people: number; last_used: string }[];
};

export type KnowledgeSource = { volume: string; subfolder: string; name: string; description: string };
export type KnowledgeSpec = {
  display_name: string;
  api_name: string;
  description: string;
  instructions: string;
  sources: KnowledgeSource[];
  access: { kind: "group" | "user"; principal: string }[];
};
export type KnowledgeDetail = {
  ka_id: string;
  api_name: string;
  display_name: string;
  description: string;
  instructions: string;
  state: string;
  endpoint_name: string;
  sources: { name: string; description: string; type: string; path: string }[];
};

export type LogLine = { at: string; level: string; source: string; message: string };
export type LogsResult = { stored: boolean; note: string; lines: LogLine[] };
export type AuditEvent = {
  at: string;
  actor: string;
  category: string;
  message: string;
  ok: boolean;
  status: number;
  error: string;
  kind: string;
  detail: { service: string; action: string; ip: string; params: Record<string, string> };
};

export type SavedChat = { id: string; endpoint: string; updated: string; count: number; title: string };
export type SavedMessage = {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  citations?: { label: string; url: string }[];
  attachments?: { name: string; path: string }[];
  files?: string[];
};

export type Reply = {
  reply: string;
  tools: string[];
  citations: { label: string; url: string }[];
  attachments: { name: string; path: string }[];
  warning?: string;
};

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
  );
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data as T;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  session: () => request<Session>("/api/session"),
  agents: () => request<{ agents: Agent[] }>("/api/agents"),
  chat: (
    endpoint: string,
    history: { role: string; content: string }[],
    files: string[],
    conversation_id?: string,
    file_names?: string[]
  ) => request<Reply>("/api/chat", { endpoint, history, files, conversation_id, file_names }),
  chats: (endpoint: string) =>
    request<{ enabled: boolean; chats: SavedChat[] }>(
      `/api/chats?endpoint=${encodeURIComponent(endpoint)}`
    ),
  chatOpen: (id: string) => request<{ messages: SavedMessage[] }>(`/api/chats/${id}`),
  chatDelete: async (id: string) => {
    const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not delete that conversation");
  },
  adminOverview: () =>
    request<{
      agents: AdminAgent[];
      groups: { name: string; id: string; local: boolean }[];
      users: { name: string; display: string }[];
    }>("/api/admin/overview"),
  grant: (endpoint_id: string, kind: string, principal: string, level: string | null) =>
    request<{ access_control_list: unknown[]; warning?: string }>("/api/admin/grant", {
      endpoint_id,
      kind,
      principal,
      level,
    }),
  dashMe: (days: number) => request<Activity>(`/api/dashboard/me?days=${days}`),
  dashInsights: (days: number) => request<Insights>(`/api/dashboard/me/insights?days=${days}`),
  dashOrg: (days: number) => request<OrgOverview>(`/api/admin/dashboard/overview?days=${days}`),
  activityFeed: (days: number, category = "", status = "", actor = "") =>
    request<ActivityFeed>(
      `/api/admin/activity?${new URLSearchParams({ days: String(days), category, status, actor }).toString()}`
    ),
  agentHealth: (days: number) => request<HealthReport>(`/api/admin/agent-health?days=${days}`),
  dashPeople: (days: number) =>
    request<{ enabled: boolean; note: string; people: PersonRow[] }>(`/api/admin/dashboard/people?days=${days}`),
  dashPerson: (user: string, days: number) =>
    request<Activity>(`/api/admin/dashboard/person?user=${encodeURIComponent(user)}&days=${days}`),
  dashCosts: (days: number) =>
    request<{
      enabled: boolean;
      available: boolean;
      note: string;
      rows: CostRow[];
      unattributed_usd: number | null;
      total_usd: number | null;
    }>(`/api/admin/dashboard/costs?days=${days}`),
  builderTypes: () => request<{ types: ToolType[] }>("/api/admin/builder/types"),
  builderSources: (kind: string, catalog = "", schema = "") =>
    request<{ items: SourceItem[]; note: string; acted_as: string }>(
      `/api/admin/builder/sources?kind=${encodeURIComponent(kind)}&catalog=${encodeURIComponent(
        catalog
      )}&schema=${encodeURIComponent(schema)}`
    ),
  mcps: (refresh = false) =>
    request<{ repo: string; ref: string; mcps: McpEntry[]; note: string; acted_as: string }>(
      `/api/admin/builder/mcps${refresh ? "?refresh=true" : ""}`
    ),
  /** Start getting ticked tools ready; the wizard then watches `mcps()` until they are. */
  mcpPrepare: (slugs: string[]) =>
    request<{ preparing: string[] }>("/api/admin/builder/mcps/prepare", { slugs }),
  builderPrincipals: () =>
    request<{
      groups: { name: string; id: string; local: boolean }[];
      users: { name: string; display: string }[];
    }>("/api/admin/builder/principals"),
  knowledgeList: () =>
    request<{
      assistants: { ka_id: string; display_name: string; description: string; state: string; endpoint_name: string }[];
    }>("/api/admin/builder/knowledge"),
  knowledgeGet: (id: string) => request<KnowledgeDetail>(`/api/admin/builder/knowledge/${id}`),
  knowledgeCreate: (spec: KnowledgeSpec) =>
    request<{ ka_id: string; endpoint_name: string; acted_as: string; warnings: string[]; access_pending: number }>(
      "/api/admin/builder/knowledge",
      spec
    ),
  knowledgeUpdate: (id: string, body: { display_name: string; description: string; instructions: string }) =>
    send<{ ka_id: string; warnings: string[] }>("PUT", `/api/admin/builder/knowledge/${id}`, body),
  knowledgeDelete: (id: string) => send<{ deleted: string }>("DELETE", `/api/admin/builder/knowledge/${id}`),
  genieList: () =>
    request<{ spaces: { space_id: string; title: string; description: string }[] }>("/api/admin/builder/genie"),
  genieGet: (id: string) => request<GenieSpace>(`/api/admin/builder/genie/${id}`),
  genieCreate: (spec: GenieSpec) =>
    request<{
      space_id: string;
      acted_as: string;
      warnings: string[];
      chat: boolean;
      access_pending: number;
    }>("/api/admin/builder/genie", spec),
  genieUpdate: (id: string, spec: GenieSpec) =>
    send<{ space_id: string }>("PUT", `/api/admin/builder/genie/${id}`, spec),
  genieDelete: (id: string) => send<{ deleted: string }>("DELETE", `/api/admin/builder/genie/${id}`),
  builderAgents: () =>
    request<{
      agents: { agent_id: string; display_name: string; description: string; endpoint_name: string; creator: string }[];
      acted_as: string;
    }>("/api/admin/builder/agents"),
  builderGet: (id: string) => request<BuilderAgent>(`/api/admin/builder/agents/${id}`),
  builderCreate: (spec: BuilderSpec) =>
    request<{
      agent_id: string;
      endpoint_name: string;
      acted_as: string;
      warnings: string[];
      access_pending: number;
      deploying: string[];
    }>(
      "/api/admin/builder/agents",
      spec
    ),
  builderUpdate: (id: string, spec: BuilderSpec) =>
    send<{ agent_id: string; acted_as: string; warnings: string[]; deploying: string[] }>("PUT", `/api/admin/builder/agents/${id}`, spec),
  builderDelete: (id: string) => send<{ deleted: string }>("DELETE", `/api/admin/builder/agents/${id}`),
  designerStatus: () => request<DesignerInfo>("/api/admin/designer/status"),
  designerTurn: (messages: DesignerMessage[], draft: DesignerDraft, models: Partial<DesignerModels> = {}) =>
    request<DesignerTurn>("/api/admin/designer/turn", {
      // only what the interview needs: no display-only fields
      messages: messages.map((m) => ({ role: m.role, content: m.content, options: m.options })),
      draft,
      models,
    }),
  designerBuild: (draft: DesignerDraft) => request<DesignerBuilt>("/api/admin/designer/build", { draft }),
  designerToolsCreate: (draft: DesignerDraft, approved: string[]) =>
    request<{ results: DesignerToolResult[] }>("/api/admin/designer/tools/create", { draft, approved }),
  designerToolsStatus: (apps: string[]) =>
    request<{ apps: Record<string, { state: string; note: string }> }>(
      `/api/admin/designer/tools/status?apps=${encodeURIComponent(apps.join(","))}`
    ),
  toolTestPlan: (slug: string, models: Partial<DesignerModels> = {}) =>
    request<ToolPlan>("/api/admin/designer/tool-test/plan", { slug, models }),
  toolTestRun: (slug: string, test: ToolTest, models: Partial<DesignerModels> = {}) =>
    request<ToolResult>("/api/admin/designer/tool-test/run", { slug, test, models }),
  toolTestFix: (slug: string, failures: ToolResult[], models: Partial<DesignerModels> = {}) =>
    request<ToolFix>("/api/admin/designer/tool-test/fix", { slug, failures, models }),
  toolTestApply: (slug: string, code: string, approved: string, what: string) =>
    request<{ started: boolean; app_name: string; since: string }>("/api/admin/designer/tool-test/apply", { slug, code, approved, what }),
  toolTestReady: (slug: string, since: string) =>
    request<{ ready: boolean; failed: boolean; note: string }>(
      `/api/admin/designer/tool-test/ready?slug=${encodeURIComponent(slug)}&since=${encodeURIComponent(since)}`
    ),
  designerTestPlan: (draft: DesignerDraft, models: Partial<DesignerModels> = {}) =>
    request<{ tests: DesignerTest[] }>("/api/admin/designer/test-plan", { draft, models }),
  designerState: (endpoint: string) =>
    request<{ state: "waiting" | "starting" | "ready" }>(
      `/api/admin/designer/assistant-state?endpoint=${encodeURIComponent(endpoint)}`
    ),
  designerTestRun: (endpoint: string, question: string, expect: string, models: Partial<DesignerModels> = {}) =>
    request<DesignerResult>("/api/admin/designer/test-run", { endpoint, question, expect, models }),
  meta: (payload: Record<string, string>) => request<unknown>("/api/admin/meta", payload),
  logs: (days: number) => request<LogsResult>(`/api/admin/logs?days=${days}`),
  /** Databricks' own audit record (system.access.audit), as sentences. */
  audit: (days: number, cats: string) =>
    request<{ available: boolean; note: string; events: AuditEvent[] }>(
      `/api/admin/audit?days=${days}&cats=${encodeURIComponent(cats)}`
    ),
  cost: (days: number) =>
    request<{
      days: number;
      available: boolean;
      note: string;
      total_usd: number | null;
      /** `raw` is the endpoint (or SKU) name the bill is recorded under. */
      lines: { sku: string; raw: string; dbus: number; usd: number | null }[];
    }>(`/api/admin/cost?days=${days}`),
};

export async function upload(endpoint: string, file: File) {
  const fd = new FormData();
  fd.append("endpoint", endpoint);
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.error || data.detail || "Upload failed");
  return data as { path: string; name: string; bytes: number };
}

// A plain GET link, not a fetch wrapper: letting the browser navigate lets it
// honour the backend's Content-Disposition header and show its own native
// download UI, rather than the app re-implementing a save-file flow.
export function downloadUrl(endpoint: string, path: string) {
  return "/api/download?" + new URLSearchParams({ endpoint, path }).toString();
}
