/** Typed calls to the Portal Deployer's backend (deployer/app.py). */

export type DeploySession = {
  user_name: string;
  display_name: string;
  allowed: boolean;
  group: string;
  mode: "apps" | "local" | "actions";
  repo: string;
  actions_url: string;
};

export type DeployStatus = "requested" | "running" | "succeeded" | "failed" | "rolled_back";
export type HealthStatus = "healthy" | "degraded" | "down" | "unverified";

export type DeployRow = {
  deploy_id: string;
  client: string;
  action: "deploy" | "rollback" | "auto_rollback";
  version: string;
  from_version: string;
  status: DeployStatus;
  step: string;
  message: string;
  actor: string;
  run_url: string;
  detail: { warnings?: string[]; health?: HealthDetail; rolled_back_to?: string; url?: string };
  at: string;
  started?: string;
};

export type HealthDetail = {
  status: HealthStatus;
  summary: string;
  version: string;
  url?: string;
  app_state?: string;
  compute_state?: string;
  questions?: number;
  failed?: number;
  failure_rate?: number;
  api_errors?: number;
  error_kinds?: { label: string; count: number }[];
  failing_assistants?: { label: string; failure_rate: number; questions: number }[];
  recent_errors?: { at: string; message: string }[];
  errors_note?: string;
};

export type HealthRow = {
  check_id: string;
  client: string;
  version: string;
  status: HealthStatus;
  summary: string;
  detail: HealthDetail;
  actor: string;
  run_url: string;
  at: string;
};

export type Client = {
  id: string;
  name: string;
  host: string;
  client_id: string;
  app_name: string;
  log_table: string;
  warehouse_id: string;
  users_group: string;
  brand_name: string;
  brand_color: string;
  /** PNG data URL, or "". */
  brand_logo: string;
  ready: boolean;
  version: string;
  last_deploy: DeployRow | null;
  in_progress: DeployRow | null;
  health: HealthRow | null;
};

export type ClientDetail = Client & { secret_set_at: string; deploys: DeployRow[]; checks: HealthRow[] };

export type Release = {
  version: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  notes: string;
  url: string;
  clients: string[];
};

export type Check = { label: string; ok: boolean; detail: string };
/** The connection check: what is in place, who it signed in as, and the
 *  catalogs that login can see (offered for chat history). */
export type TestResult = { ok: boolean; checks: Check[]; who: string; catalogs?: string[] };

export type SetupCheck = { key: string; label: string; status: "ok" | "fail" | "blocked"; detail: string; fix: string };
export type Setup = { ready: boolean; problems: number; checks: SetupCheck[]; repo: string; checked_at: number };

export type ClientForm = {
  slug?: string;
  name?: string;
  host?: string;
  client_id?: string;
  secret?: string;
  app_name?: string;
  log_table?: string;
  warehouse_id?: string;
  users_group?: string;
  brand_name?: string;
  brand_color?: string;
  brand_logo?: string;
};

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const dapi = {
  session: () => send<DeploySession>("GET", "/api/session"),
  clients: () => send<{ clients: Client[]; note: string; repo: string; actions_url: string }>("GET", "/api/clients"),
  client: (id: string) => send<ClientDetail>("GET", `/api/clients/${enc(id)}`),
  test: (f: ClientForm) => send<TestResult>("POST", "/api/clients/test", f),
  add: (f: ClientForm) => send<{ id: string }>("POST", "/api/clients", f),
  edit: (id: string, f: ClientForm) => send<{ id: string }>("PATCH", `/api/clients/${enc(id)}`, f),
  remove: (id: string) => send<{ ok: boolean }>("DELETE", `/api/clients/${enc(id)}`),
  deploy: (id: string, version: string) => send<{ deploy_id: string; version: string }>("POST", `/api/clients/${enc(id)}/deploy`, { version }),
  rollback: (id: string, version = "") =>
    send<{ deploy_id: string; version: string }>("POST", `/api/clients/${enc(id)}/rollback`, { version }),
  status: (deployId: string) =>
    send<{ steps: DeployRow[]; current: DeployRow; run: { status: string; conclusion: string | null; url: string } | null }>(
      "GET",
      `/api/deploys/${enc(deployId)}`
    ),
  check: (id: string) => send<{ check_id: string }>("POST", `/api/clients/${enc(id)}/check`),
  checkResult: (id: string, checkId: string) =>
    send<{ done: boolean; check?: HealthRow | null; error?: string; run?: { url: string } | null }>(
      "GET",
      `/api/clients/${enc(id)}/check/${enc(checkId)}`
    ),
  releases: () => send<{ releases: Release[]; repo: string }>("GET", "/api/releases"),
  setup: (fresh = false) => send<Setup>("GET", `/api/setup${fresh ? "?fresh=true" : ""}`),
};
