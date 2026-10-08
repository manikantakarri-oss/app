"use client";

import { useState } from "react";
import type { DesignerFile } from "@/lib/api";
import { VolumeField } from "../BuilderParts";
import { Dialog } from "../deployer/parts";
import { CloseIcon, FileIcon } from "../icons";

/** Files attached while designing.
 *
 *  Where they are kept is the admin's choice (a folder, optionally a sub-folder),
 *  asked once and remembered in this browser, never fixed in the portal. They are
 *  saved with the admin's own permissions, so they can only use folders they may
 *  write to. The designer reads them to design around the real content, and the
 *  assistant it builds can be pointed at the same folder. */

const KEY = "agent-portal-designer-files";
export const ACCEPT = ".xlsx,.xlsm,.csv,.tsv,.txt,.md,.json,.xml,.yaml,.yml,.pdf,.docx,.pptx,.html,.htm";
export const MAX_FILES = 10;
export const MAX_BYTES = 100 * 1024 * 1024;

export function loadFolder(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function saveFolder(v: string) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private windows can refuse storage; the folder is then asked again next time.
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** What the designer model is told about attached files, under the admin's words. */
export function describeFiles(files: DesignerFile[]): string {
  return files.map((f) => `Attached file: ${f.name} at ${f.path} (${f.kind}, ${fmtBytes(f.bytes)})`).join("\n");
}

/** A message's own words, without the "Attached file" lines (they are shown as chips). */
export function withoutFileLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith("Attached file: "))
    .join("\n")
    .trim();
}

export function FolderDialog({ initial, onSave, onClose }: { initial: string; onSave: (folder: string) => void; onClose: () => void }) {
  const [vol, sub0] = [initial.split("/")[0] || "", initial.split("/").slice(1).join("/")];
  const [volume, setVolume] = useState(vol);
  const [sub, setSub] = useState(initial ? sub0 : "assistant-files");
  const [pasted, setPasted] = useState("");
  // "/Volumes/c/s/v/a/b" or "c.s.v/a/b" -> folder c.s.v and sub-folder a/b.
  function applyPasted(text: string) {
    setPasted(text);
    const t = text.trim().replace(/\/+$/, "");
    const m = t.match(/^\/Volumes\/([\w-]+)\/([\w-]+)\/([\w-]+)((?:\/[^/]+)*)$/) || t.match(/^([\w-]+)\.([\w-]+)\.([\w-]+)((?:\/[^/]+)*)$/);
    if (!m) {
      setVolume("");
      return;
    }
    setVolume(`${m[1]}.${m[2]}.${m[3]}`);
    setSub((m[4] || "").replace(/^\//, ""));
  }
  const bad = sub.trim() !== "" && (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}){0,3}$/.test(sub.trim()) || sub.includes(".."));
  const folder = volume ? volume + (sub.trim() ? "/" + sub.trim().replace(/^\/+|\/+$/g, "") : "") : "";
  return (
    <Dialog
      wide
      title="Where should attached files be kept?"
      sub="Asked once, then remembered in this browser. You can change it any time."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!volume || bad} onClick={() => onSave(folder)}>
            Use this folder
          </button>
        </>
      }
    >
      <p className="mb-4 text-[14px] muted">
        Files you attach are saved here with your own permissions, so choose a folder you can save to. If the assistant will use the
        file (an ad book, a rate card), pick a folder the people using it can read.
      </p>
      <label className="block">
        <span className="text-[13px] font-semibold">Paste a folder path</span>
        <input
          className="field mt-1 font-mono !text-[13px]"
          value={pasted}
          onChange={(e) => applyPasted(e.target.value)}
          placeholder="/Volumes/catalog/schema/folder/sub-folder   or   catalog.schema.folder"
          spellCheck={false}
          autoComplete="off"
        />
        {pasted && !volume ? (
          <span className="mt-1 block text-[12.5px]" style={{ color: "var(--err)" }}>
            That is not a folder path. It looks like /Volumes/catalog/schema/folder.
          </span>
        ) : null}
      </label>
      <p className="my-4 flex items-center gap-3 text-[12.5px] faint">
        <span className="h-px flex-1" style={{ background: "var(--line)" }} /> or browse <span className="h-px flex-1" style={{ background: "var(--line)" }} />
      </p>
      <VolumeField label="Folder" hint="" value={volume} suffix={sub.trim() ? "/" + sub.trim() : ""} onChange={(v) => { setVolume(v); setPasted(""); }} />
      <label className="mt-4 block">
        <span className="text-[13px] font-medium muted">Sub-folder (optional)</span>
        <input className="field mt-1" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="assistant-files" maxLength={200} />
        {bad ? <span className="mt-1 block text-[12.5px]" style={{ color: "var(--err)" }}>Use letters, numbers, spaces, dashes and dots, up to four levels.</span> : null}
      </label>
    </Dialog>
  );
}

export type Pending = {
  id: string;
  file: File;
  state: "uploading" | "done" | "conflict" | "error";
  done?: DesignerFile;
  error?: string;
};

/** Files waiting to go with the next message. */
export function AttachChips({
  items,
  onRemove,
  onResolve,
}: {
  items: Pending[];
  onRemove: (p: Pending) => void;
  onResolve: (p: Pending, how: "replace" | "keep_both") => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached files">
      {items.map((p) => {
        const bad = p.state === "error";
        return (
          <li
            key={p.id}
            className="flex max-w-full items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[13px]"
            style={{
              borderColor: bad ? "color-mix(in srgb, var(--err) 45%, var(--line))" : p.state === "conflict" ? "var(--warn-line)" : "var(--line)",
              background: "var(--surface)",
            }}
          >
            <span className="dz-tile !h-7 !w-7 !rounded-lg" aria-hidden>
              {p.state === "uploading" ? <span className="dz-spin" /> : <FileIcon size={14} />}
            </span>
            <span className="min-w-0">
              <span className="block max-w-[220px] truncate font-medium" title={p.file.name}>
                {p.done?.name || p.file.name}
              </span>
              <span className="block text-[11.5px] faint">
                {p.state === "uploading"
                  ? "Uploading…"
                  : p.state === "conflict"
                    ? "Already in that folder"
                    : bad
                      ? "Not attached"
                      : `${p.done?.kind || "File"} · ${fmtBytes(p.file.size)}`}
              </span>
              {bad ? <span className="block max-w-[320px] text-[11.5px]" style={{ color: "var(--err)" }}>{p.error}</span> : null}
              {p.state === "conflict" ? (
                <span className="mt-1 flex gap-2 text-[12px] font-medium">
                  <button type="button" className="underline" onClick={() => onResolve(p, "replace")}>
                    Replace it
                  </button>
                  <button type="button" className="underline" onClick={() => onResolve(p, "keep_both")}>
                    Keep both
                  </button>
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="icon-btn !h-7 !w-7 shrink-0"
              onClick={() => onRemove(p)}
              aria-label={`Remove ${p.file.name}`}
              disabled={p.state === "uploading"}
            >
              <CloseIcon size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Files shown on a message that was sent with them. */
export function FileChips({ files, mine }: { files: DesignerFile[]; mine?: boolean }) {
  return (
    <ul className={mine ? "mt-2 flex flex-wrap justify-end gap-1.5" : "mt-2 flex flex-wrap gap-1.5"}>
      {files.map((f) => (
        <li key={f.path} className="dz-pill !bg-[var(--surface)]" title={f.path} style={{ border: "1px solid var(--line)" }}>
          <FileIcon size={12} />
          <span className="max-w-[240px] truncate">{f.name}</span>
          <span className="whitespace-nowrap faint">{fmtBytes(f.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}
