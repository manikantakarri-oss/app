"use client";

import { useRef, useState } from "react";
import { designerConnect, DesignerConnection } from "@/lib/api";
import { ErrorBox } from "../bits";
import { Dialog } from "../deployer/parts";
import { CheckIcon, ShieldIcon } from "../icons";

/** Connecting a credential a new tool needs (a Google Drive key, an API token).
 *
 *  This form is the only way a credential enters the portal, and it is kept apart
 *  from the conversation on purpose: the value goes from here to the workspace's
 *  secret store and nowhere else. It is never put in the chat, the draft or this
 *  browser's storage, and the AI model only ever learns "connected". */
export function ConnectDialog({
  c,
  connected,
  onClose,
  onSaved,
}: {
  c: DesignerConnection;
  connected: boolean;
  onClose: () => void;
  onSaved: (c: DesignerConnection) => void;
}) {
  const [value, setValue] = useState("");
  const [fileName, setFileName] = useState("");
  const [paste, setPaste] = useState(c.kind !== "key_file");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [needReplace, setNeedReplace] = useState(connected);
  const input = useRef<HTMLInputElement>(null);

  async function onFile(f: File | undefined) {
    setErr("");
    if (!f) return;
    if (f.size > 64 * 1024) {
      setErr("That file is too large to be a key (64 KB at most).");
      return;
    }
    setValue(await f.text());
    setFileName(f.name);
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await designerConnect(c.name, value, c.kind, needReplace);
      setValue(""); // not kept a moment longer than needed
      onSaved(c);
    } catch (e: any) {
      if (e.status === 409) setNeedReplace(true);
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`${connected ? "Replace" : "Connect"} ${c.label}`}
      sub={c.what_for || undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !value.trim()}>
            {busy ? "Saving…" : needReplace ? "Replace securely" : "Save securely"}
          </button>
        </>
      }
    >
      <div className="flex gap-3 rounded-xl p-3" style={{ background: "var(--brand-soft)" }}>
        <span className="mt-0.5 shrink-0" style={{ color: "var(--brand-deep)" }} aria-hidden>
          <ShieldIcon size={18} />
        </span>
        <p className="text-[13.5px]">
          Saved encrypted in your workspace&apos;s secret store as <b className="font-mono text-[12.5px]">{c.name}</b>. The AI model never
          sees it, it is never shown again, and only the tool that needs it can read it.
        </p>
      </div>

      {c.how_to_get ? (
        <div className="mt-4">
          <p className="text-[13px] font-semibold">Where to get it</p>
          <p className="mt-1 text-[14px] muted">{c.how_to_get}</p>
        </div>
      ) : null}

      <div className="mt-4">
        {c.kind === "key_file" && !paste ? (
          <>
            <p className="text-[13px] font-semibold">Key file</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-quiet" onClick={() => input.current?.click()} disabled={busy}>
                {fileName ? "Choose another file" : "Choose the key file"}
              </button>
              {fileName ? (
                <span className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--ok)" }}>
                  <CheckIcon size={14} /> {fileName}
                </span>
              ) : null}
              <input ref={input} type="file" accept=".json,.pem,.p12,.key,.txt,application/json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
            <button type="button" className="mt-2 text-[12.5px] underline muted" onClick={() => setPaste(true)}>
              Paste it instead
            </button>
          </>
        ) : (
          <label className="block">
            <span className="text-[13px] font-semibold">{c.kind === "key_file" ? "Key file contents" : "Value"}</span>
            {c.kind === "key_file" ? (
              <textarea
                className="field mt-1 min-h-[120px] font-mono !text-[12.5px]"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder="Paste the whole file"
              />
            ) : (
              <input
                className="field mt-1 font-mono"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Paste the token or password"
              />
            )}
          </label>
        )}
      </div>
      {needReplace && connected ? (
        <p className="mt-3 text-[12.5px] faint">This replaces the saved value. Tools that use it pick up the new one when they restart.</p>
      ) : null}
      {err ? (
        <div className="mt-3">
          <ErrorBox>{err}</ErrorBox>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The connections a design needs, with their state and a button each. */
export function ConnectionRows({
  list,
  status,
  onConnect,
}: {
  list: DesignerConnection[];
  status: Record<string, boolean>;
  onConnect: (c: DesignerConnection) => void;
}) {
  return (
    <ul className="space-y-2">
      {list.map((c) => {
        const ok = !!status[c.name];
        return (
          <li key={c.name} className="flex items-center gap-2.5 rounded-xl border px-3 py-2" style={{ borderColor: ok ? "var(--line)" : "var(--warn-line)" }}>
            <span
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={ok ? { background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)" } : { background: "var(--warn-bg)", color: "var(--warn-line)" }}
              aria-hidden
            >
              {ok ? <CheckIcon size={14} /> : <ShieldIcon size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{c.label}</span>
              <span className="block text-[12px] faint">{ok ? "Connected" : "Not connected yet"}</span>
            </span>
            <button type="button" className={ok ? "btn btn-quiet !min-h-0 !py-1.5 text-[13px]" : "btn btn-primary !min-h-0 !py-1.5 text-[13px]"} onClick={() => onConnect(c)}>
              {ok ? "Replace" : "Connect"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
