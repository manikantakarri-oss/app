"use client";

import { Agent } from "@/lib/api";
import { StatusDot, Tag } from "./bits";
import { SparkleIcon } from "./icons";

/** What kind of assistant this is, in words anyone would use. The backend's own
 *  labels ("Multi-agent") are accurate but mean nothing to most people. */
const KIND_PLAIN: Record<string, string> = {
  supervisor: "Uses several tools",
  knowledge: "Answers from documents",
  agent: "Custom assistant",
  model: "General assistant",
};

/** One assistant, as a card you click to start talking to it. */
export function AgentCard({ agent, onOpen }: { agent: Agent; onOpen: (a: Agent) => void }) {
  const disabled = !agent.ready;
  return (
    <button
      type="button"
      onClick={() => onOpen(agent)}
      disabled={disabled}
      className="card flex w-full flex-col p-5 text-left transition hover:border-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--brand-soft)", color: "var(--brand-deep)" }}
        >
          <SparkleIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-snug">{agent.display_name}</h3>
          {agent.metered ? (
            <span className="mt-1 inline-block">
              <Tag title="Each message is charged to the workspace.">
                {agent.light ? "Lower cost" : "Higher cost"}
              </Tag>
            </span>
          ) : null}
        </div>
      </div>

      {/* A model's description only repeats the cost tag above, so skip it and
          keep the card quiet. Assistants have real descriptions worth showing. */}
      {agent.metered ? null : (
        <p className="mt-3 line-clamp-3 text-sm muted">
          {agent.blurb || "No description has been added for this one yet."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs faint">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot ok={agent.ready} />
          {agent.ready ? "Ready to chat" : "Starting up. Try again in a few minutes"}
        </span>
        <span>{KIND_PLAIN[agent.kind] || agent.kind_label}</span>
        {agent.supports_files ? <span>You can send it files</span> : null}
        {agent.output_volume ? <span>It can give back files</span> : null}
      </div>

      {agent.ready ? (
        <p className="mt-4 text-sm font-medium" style={{ color: "var(--brand-deep)" }}>
          Start chatting →
        </p>
      ) : null}
    </button>
  );
}
