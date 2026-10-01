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
export type BuilderTool = {
  type: string;
  ref: string;
  description: string;
  tool_id?: string;
  readonly?: boolean;
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
  tools: { type: string; ref: string; description: string }[];
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
  models: () =>
    request<{ enabled: boolean; allowed: boolean; reason: string; models: Agent[] }>("/api/models"),
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
    }>(
      "/api/admin/builder/agents",
      spec
    ),
  builderUpdate: (id: string, spec: BuilderSpec) =>
    send<{ agent_id: string; acted_as: string; warnings: string[] }>("PUT", `/api/admin/builder/agents/${id}`, spec),
  builderDelete: (id: string) => send<{ deleted: string }>("DELETE", `/api/admin/builder/agents/${id}`),
  meta: (payload: Record<string, string>) => request<unknown>("/api/admin/meta", payload),
  llmState: () =>
    request<{
      enabled: boolean;
      group: string;
      group_id: string | null;
      members: string[];
      members_visible?: boolean;
    }>("/api/admin/llm"),
  llmSet: (payload: Record<string, unknown>) => request<unknown>("/api/admin/llm", payload),
  logs: (days: number) => request<LogsResult>(`/api/admin/logs?days=${days}`),
  cost: (days: number) =>
    request<{
      days: number;
      available: boolean;
      note: string;
      total_usd: number | null;
      lines: { sku: string; dbus: number; usd: number | null }[];
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
