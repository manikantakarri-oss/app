"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import { Client, dapi, DeploySession, Release, Setup } from "@/lib/deployer";
import { ClientsPage } from "@/components/deployer/Clients";
import { ClientPage } from "@/components/deployer/ClientPage";
import { AddClient } from "@/components/deployer/AddClient";
import { ReleasesPage } from "@/components/deployer/Releases";
import { SetupPage } from "@/components/deployer/SetupPage";
import { ErrorBox, Spinner } from "@/components/bits";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowUpRightIcon, BuildingIcon, ChevronRightIcon, CloseIcon, MenuIcon, RocketIcon, ShieldIcon, TagIcon } from "@/components/icons";
import { initials } from "@/lib/people";

/** The Portal Deployer's shell: the portal's own sidebar and top bar, with two
 *  sections. Where you are lives in the URL hash (#clients, #client/<id>,
 *  #add, #releases, #setup), so any page can be linked to and survives a refresh. */
type View = { page: "clients" } | { page: "client"; id: string } | { page: "add" } | { page: "releases" } | { page: "setup" };

function parse(hash: string): View {
  const h = hash.replace(/^#/, "");
  if (h.startsWith("client/")) return { page: "client", id: decodeURIComponent(h.slice(7)) };
  if (h === "add") return { page: "add" };
  if (h === "releases") return { page: "releases" };
  if (h === "setup") return { page: "setup" };
  return { page: "clients" };
}

function hashOf(v: View) {
  return v.page === "client" ? `#client/${encodeURIComponent(v.id)}` : v.page === "clients" ? "#" : `#${v.page}`;
}

const POLL_MS = 15000;

export default function DeployerPage() {
  const [session, setSession] = useState<DeploySession | null>(null);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<View>({ page: "clients" });
  const [drawer, setDrawer] = useState(false);
  const [clients, setClients] = useState<{ clients: Client[]; note: string } | null>(null);
  const [clientsErr, setClientsErr] = useState("");
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releasesErr, setReleasesErr] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupErr, setSetupErr] = useState("");
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    setView(parse(window.location.hash));
    const on = () => setView(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  function go(v: View) {
    setView(v);
    setDrawer(false);
    window.history.pushState(null, "", hashOf(v) === "#" ? window.location.pathname + window.location.search : hashOf(v));
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    dapi.session().then(setSession).catch((e) => setFatal(e.message));
  }, []);

  const loadClients = useCallback(() => {
    dapi
      .clients()
      .then((d) => {
        setClients(d);
        setClientsErr("");
      })
      .catch((e) => setClientsErr(e.message));
  }, []);
  const loadReleases = useCallback(() => {
    dapi
      .releases()
      .then((d) => {
        setReleases(d.releases);
        setReleasesErr("");
      })
      .catch((e) => {
        setReleases([]);
        setReleasesErr(e.message);
      });
  }, []);

  useEffect(() => {
    if (!session?.allowed) return;
    loadClients();
    loadReleases();
    dapi
      .setup()
      .then(setSetup)
      .catch((e) => setSetupErr(e.message));
  }, [session, loadClients, loadReleases]);

  // Releases change outside this page (a tag pushed, a deploy finished), so
  // the list is reloaded each time the page is shown.
  useEffect(() => {
    if (session?.allowed && view.page === "releases") loadReleases();
  }, [view.page, session, loadReleases]);

  // Keep the overview current while something is deploying somewhere.
  useEffect(() => {
    if (!clients?.clients.some((c) => c.in_progress)) return;
    const t = setTimeout(loadClients, POLL_MS);
    return () => clearTimeout(t);
  }, [clients, loadClients]);

  if (fatal) {
    return (
      <Splash>
        <div className="w-full max-w-md">
          <ErrorBox>{fatal}</ErrorBox>
        </div>
      </Splash>
    );
  }
  if (!session) {
    return (
      <Splash>
        <Spinner label="Signing you in…" />
      </Splash>
    );
  }
  if (!session.allowed) {
    return (
      <Splash>
        <p className="max-w-md text-center text-[15px] muted">
          The deployer is for members of the <b>{session.group}</b> group. Ask a workspace admin to add you.
        </p>
      </Splash>
    );
  }

  const section = view.page === "releases" ? "releases" : view.page === "setup" ? "setup" : "clients";
  const setupProblems = setup ? setup.problems : 0;
  const current = view.page === "client" ? clients?.clients.find((c) => c.id === view.id) : undefined;
  const crumb = view.page === "client" ? current?.name || view.id.replace(/^client-/, "") : view.page === "add" ? "Add client" : null;

  return (
    <div className="flex min-h-dvh">
      {drawer ? <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setDrawer(false)} aria-hidden /> : null}
      <aside
        className={`side fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col transition-transform duration-200 lg:sticky lg:top-0 lg:z-30 lg:h-dvh lg:w-[264px] lg:translate-x-0 ${
          drawer ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Main menu"
      >
        <div className="flex h-16 shrink-0 items-center gap-3 px-5">
          <button type="button" className="flex min-w-0 items-center gap-3" onClick={() => go({ page: "clients" })}>
            <span className="side-mark" aria-hidden>
              <RocketIcon size={20} />
            </span>
            <span className="min-w-0 text-left leading-tight">
              <span className="block text-[15px] font-semibold tracking-[-0.01em]">Portal Deployer</span>
              <span className="block truncate text-[12px]" style={{ color: "var(--side-faint)" }}>
                Agent Portal for every client
              </span>
            </span>
          </button>
          <button type="button" className="side-icon-btn ml-auto lg:hidden" onClick={() => setDrawer(false)} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>

        <nav className="side-scroll mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4" aria-label="Sections">
          <p className="side-label">Deploy</p>
          <div className="flex flex-col gap-0.5">
            <NavItem icon={<BuildingIcon />} label="Clients" active={section === "clients"} count={clients?.clients.length} onClick={() => go({ page: "clients" })} />
            <NavItem icon={<TagIcon />} label="Releases" active={section === "releases"} count={releases?.length} onClick={() => go({ page: "releases" })} />
            <NavItem icon={<ShieldIcon />} label="Setup" active={section === "setup"} alert={setupProblems} onClick={() => go({ page: "setup" })} />
          </div>
          <p className="side-label">GitHub</p>
          <a className="side-link" href={session.actions_url} target="_blank" rel="noreferrer" title="Deploy and check jobs on GitHub">
            <span className="shrink-0">
              <ArrowUpRightIcon />
            </span>
            <span className="flex-1 truncate">Jobs</span>
          </a>
        </nav>

        <div className="shrink-0 border-t p-3" style={{ borderColor: "var(--side-line)" }}>
          <div className="flex items-center gap-3 rounded-lg p-1.5" title={session.user_name}>
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
              style={{ background: "linear-gradient(135deg, var(--mark-from), var(--mark-to))", color: "#fff" }}
              aria-hidden
            >
              {initials(session.display_name)}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-semibold">{session.display_name}</span>
              <span className="block truncate text-[12px]" style={{ color: "var(--side-faint)" }}>
                {session.mode === "local" ? "local dev · your CLI identity" : `Deployer · ${session.repo}`}
              </span>
            </span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="topbar sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 px-4 lg:px-8">
          <button type="button" className="icon-btn lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}>
            <MenuIcon />
          </button>
          <nav aria-label="You are here" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden shrink-0 muted sm:inline">Portal Deployer</span>
            <span className="hidden faint sm:inline" aria-hidden>
              <ChevronRightIcon size={14} />
            </span>
            {crumb ? (
              <>
                <button type="button" className="shrink-0 muted hover:underline" onClick={() => go({ page: "clients" })}>
                  Clients
                </button>
                <span className="faint" aria-hidden>
                  <ChevronRightIcon size={14} />
                </span>
                <span className="truncate font-semibold">{crumb}</span>
              </>
            ) : (
              <span className="truncate font-semibold">{section === "releases" ? "Releases" : section === "setup" ? "Setup" : "Clients"}</span>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 pb-20 pt-6 sm:px-6 lg:px-10 lg:pt-8">
          {view.page === "clients" ? (
            <ClientsPage
              data={clients}
              err={clientsErr}
              setup={setup}
              releases={releases}
              onOpen={(id) => go({ page: "client", id })}
              onAdd={() => go({ page: "add" })}
              onSetup={() => go({ page: "setup" })}
            />
          ) : view.page === "client" ? (
            <ClientPage
              key={view.id}
              id={view.id}
              releases={releases}
              notice={notice?.id === view.id ? notice.text : ""}
              onBack={() => go({ page: "clients" })}
              onChanged={() => {
                loadClients();
                loadReleases(); // which clients run which version changes with every deploy
              }}
              onRemoved={() => {
                loadClients();
                go({ page: "clients" });
              }}
            />
          ) : view.page === "add" ? (
            <AddClient
              releases={releases}
              onBack={() => go({ page: "clients" })}
              onAdded={(id, deployError) => {
                setNotice(deployError ? { id, text: deployError } : null);
                loadClients();
                go({ page: "client", id });
              }}
            />
          ) : view.page === "setup" ? (
            <SetupPage setup={setup} err={setupErr} onRefresh={setSetup} />
          ) : (
            <ReleasesPage releases={releases} err={releasesErr} clients={clients?.clients || []} repo={session.repo} onOpen={(id) => go({ page: "client", id })} onWatch={() => { loadClients(); go({ page: "clients" }); }} />
          )}
        </main>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, count, alert, onClick }: { icon: ReactNode; label: string; active: boolean; count?: number; alert?: number; onClick: () => void }) {
  return (
    <button type="button" className="side-link" data-state={active ? "active" : "inactive"} aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {alert ? (
        <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums" style={{ background: "var(--warn-bg)", color: "var(--warn-line)" }} title={`${alert} need attention`}>
          {alert}
        </span>
      ) : count ? (
        <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums" style={{ background: "var(--side-chip)", color: "var(--side-dim)" }}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <span className="side-mark !h-12 !w-12 !rounded-2xl" aria-hidden>
        <RocketIcon size={26} />
      </span>
      <p className="text-lg font-semibold tracking-[-0.01em]">Portal Deployer</p>
      {children}
    </main>
  );
}
