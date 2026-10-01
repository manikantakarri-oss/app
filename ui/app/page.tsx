"use client";

import { useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Agent, api, Session } from "@/lib/api";
import { AgentCard } from "@/components/AgentCard";
import { ModelChoice } from "@/components/ModelChoice";
import { Chat } from "@/components/Chat";
import { Admin } from "@/components/Admin";
import { Builder } from "@/components/Builder";
import { Dashboard } from "@/components/Dashboard";
import { Empty, ErrorBox, SectionHead, Spinner } from "@/components/bits";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SparkleIcon } from "@/components/icons";
import { initials, nameOf } from "@/lib/people";

export default function Page() {
  const [session, setSession] = useState<Session | null>(null);
  const [fatal, setFatal] = useState("");

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsErr, setAgentsErr] = useState("");

  const [models, setModels] = useState<Agent[] | null>(null);
  const [modelsNote, setModelsNote] = useState("");
  const [modelsOffered, setModelsOffered] = useState(false);

  const [open, setOpen] = useState<Agent | null>(null);
  const [tab, setTab] = useState("agents");
  const [find, setFind] = useState("");
  const headerRef = useRef<HTMLElement>(null);

  // Tabs are reflected in the URL so a section can be linked to and survives
  // a refresh.
  useEffect(() => {
    const want = window.location.hash.replace("#", "");
    if (want === "models" || want === "admin" || want === "build" || want === "dashboard") setTab(want);
  }, []);

  function pickTab(next: string) {
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", next === "agents" ? "#" : "#" + next);
    }
  }

  useEffect(() => {
    api
      .session()
      .then(setSession)
      .catch((e) => setFatal(e.message));
  }, []);

  useEffect(() => {
    if (!session) return;
    api
      .agents()
      .then((d) => setAgents(d.agents))
      .catch((e) => setAgentsErr(e.message));
    api
      .models()
      .then((d) => {
        setModelsOffered(d.allowed);
        setModels(d.models);
        setModelsNote(d.reason || "");
      })
      .catch(() => setModelsOffered(false));
  }, [session]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--header-h", el.offsetHeight + "px");
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session]);

  if (fatal) {
    return (
      <Main>
        <div className="mt-10">
          <ErrorBox>{fatal}</ErrorBox>
        </div>
      </Main>
    );
  }

  if (!session) {
    return (
      <Main>
        <div className="mt-10">
          <Spinner label="Signing you in…" />
        </div>
      </Main>
    );
  }

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => {
        // Navigating always leaves an open chat, so the bar works from anywhere.
        setOpen(null);
        pickTab(v);
      }}
    >
      <header ref={headerRef} className="app-header sticky top-0 z-20 flex flex-wrap items-center gap-x-6 px-5 lg:px-10">
        <div className="flex h-16 items-center gap-3">
          <span className="logo-mark" aria-hidden>
            <SparkleIcon size={20} />
          </span>
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Agent Portal</span>
        </div>

        <nav
          className="order-last -mx-5 w-full overflow-x-auto px-5 [scrollbar-width:none] lg:order-none lg:mx-0 lg:w-auto lg:flex-1 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden"
          aria-label="Main"
        >
          <Tabs.List className="flex" aria-label="Sections">
            <TabButton value="agents">Your assistants</TabButton>
            <TabButton value="dashboard">My dashboard</TabButton>
            {modelsOffered ? <TabButton value="models">General assistant</TabButton> : null}
            {session.is_admin ? <TabButton value="build">Create an assistant</TabButton> : null}
            {session.is_admin ? <TabButton value="admin">Admin</TabButton> : null}
          </Tabs.List>
        </nav>

        <div className="ml-auto flex h-16 items-center gap-3 lg:ml-0">
          <div className="flex items-center gap-3" title={session.user_name}>
            <span className="avatar" aria-hidden>
              {initials(session.display_name)}
            </span>
            <span className="hidden min-w-0 leading-tight md:block">
              <span className="block max-w-[220px] truncate text-sm font-semibold">
                {session.display_name.includes("@") ? nameOf(session.display_name) : session.display_name}
              </span>
              <span className="block text-xs faint">
                {session.is_admin ? "Administrator" : "Member"}
                {session.auth_mode === "local-dev" ? " · local" : ""}
              </span>
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <Main wide={!!open}>
        {open ? (
          <Chat
            agent={open}
            agents={agents || []}
            historyEnabled={session.chat_history}
            models={models || []}
            onBack={() => setOpen(null)}
            onSwitch={setOpen}
          />
        ) : (
          <>
            <Tabs.Content value="agents">
              <div className="mb-6">
                <h1 className="text-2xl font-semibold tracking-tight">
                  Hi {firstName(session.display_name)}, how can we help today?
                </h1>
                <p className="mt-1.5 text-[15px] muted">
                  Choose an assistant below, then type your question the way you would ask a
                  colleague.
                </p>
              </div>
              <ErrorBox>{agentsErr}</ErrorBox>
              {agents === null ? (
                <Spinner label="Loading your assistants…" />
              ) : agents.length === 0 ? (
                <Empty
                  title="You do not have any assistants yet"
                  hint="An admin needs to give you access before anything appears here."
                />
              ) : (
                <>
                  {agents.length > 6 ? (
                    <input
                      className="field mb-4 max-w-md"
                      type="search"
                      value={find}
                      onChange={(e) => setFind(e.target.value)}
                      placeholder="Search your assistants"
                      aria-label="Search your assistants"
                    />
                  ) : null}
                  {(() => {
                    const q = find.trim().toLowerCase();
                    const shown = agents.filter(
                      (a) =>
                        !q ||
                        a.display_name.toLowerCase().includes(q) ||
                        (a.blurb || "").toLowerCase().includes(q)
                    );
                    return shown.length === 0 ? (
                      <p className="text-sm muted">No assistants match “{find}”.</p>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
                        {shown.map((a) => (
                          <AgentCard key={a.name} agent={a} onOpen={setOpen} />
                        ))}
                      </div>
                    );
                  })()}
                </>
              )}
            </Tabs.Content>

            <Tabs.Content value="dashboard">
              <Dashboard isAdmin={session.is_admin} />
            </Tabs.Content>

            {modelsOffered ? (
              <Tabs.Content value="models">
                {models === null ? (
                  <Spinner label="Loading…" />
                ) : models.length === 0 ? (
                  <Empty title="No models are available to you" hint={modelsNote} />
                ) : (
                  <ModelChoice models={models} onOpen={setOpen} />
                )}
              </Tabs.Content>
            ) : null}

            {session.is_admin ? (
              <Tabs.Content value="build">
                <Builder onGoto={pickTab} />
              </Tabs.Content>
            ) : null}

            {session.is_admin ? (
              <Tabs.Content value="admin">
                <Admin />
              </Tabs.Content>
            ) : null}
          </>
        )}
      </Main>
    </Tabs.Root>
  );
}

/** "Hi Soham" reads better than "Hi soham.kamtikar@databeat.io". */
function firstName(display: string) {
  const base = (display || "").split("@")[0].replace(/[._]/g, " ").trim();
  const first = base.split(/\s+/)[0] || "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function TabButton({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger value={value} className="nav-tab">
      {children}
    </Tabs.Trigger>
  );
}

function Main({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  // A conversation gets the whole window, edge to edge; the card grids and admin
  // pages stay in a centred column, where long lines would be hard to scan.
  return (
    <main
      className={
        wide
          ? "w-full"
          : "w-full px-5 pb-20 pt-8 lg:px-10"
      }
    >
      {children}
    </main>
  );
}
