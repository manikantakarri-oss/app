"use client";

import { useRef, useState } from "react";
import { colourNotes, dominantColour, HEX_RE, palette } from "@/lib/brand";
import { CloseIcon, SparkleIcon, UploadIcon } from "@/components/icons";
import { Field } from "./parts";

export type Brand = { name: string; color: string; logo: string };

/** The portal's default teal, shown when no brand colour is chosen. */
const DEFAULT = "#00b5b0";
const PRESETS = ["#1a73e8", "#4f46e5", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#16a34a", "#0f172a"];
// GitHub stores each setting up to 48 KB; leave headroom.
const LOGO_MAX = 40_000;

/** Read any image, fit it inside `size` px, return a PNG data URL and the
 *  pixels (for the colour suggestion). Converting here means the portal only
 *  ever serves a small PNG: an uploaded SVG cannot carry script through. */
async function toPng(file: File, size: number): Promise<{ url: string; pixels: Uint8ClampedArray }> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("That file is not an image the browser can read."));
      i.src = src;
    });
    const w0 = img.naturalWidth || size;
    const h0 = img.naturalHeight || size;
    const k = Math.min(1, size / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    return { url: canvas.toDataURL("image/png"), pixels: ctx.getImageData(0, 0, w, h).data };
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function BrandingEditor({ value, onChange, stacked }: { value: Brand; onChange: (b: Brand) => void; stacked?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [suggest, setSuggest] = useState("");
  const [hexText, setHexText] = useState(value.color);
  const file = useRef<HTMLInputElement>(null);
  const color = HEX_RE.test(value.color) ? value.color : "";
  const notes = colourNotes(color);

  async function upload(f: File | undefined) {
    if (!f) return;
    setErr("");
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(f.type)) {
      setErr("Use a PNG, JPG, WebP or SVG image.");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setErr("That file is over 5 MB. Use a smaller image.");
      return;
    }
    setBusy(true);
    try {
      for (const size of [256, 192, 128, 96]) {
        const out = await toPng(f, size);
        if (out.url.length <= LOGO_MAX) {
          const hint = dominantColour(out.pixels);
          setSuggest(hint);
          onChange({ ...value, logo: out.url, color: value.color || hint });
          if (!value.color && hint) setHexText(hint);
          return;
        }
      }
      setErr("That logo has too much detail to store. Try a simpler version, or a PNG with fewer colours.");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  function setColor(c: string) {
    setHexText(c);
    onChange({ ...value, color: c });
  }

  return (
    // `stacked` puts the preview under the fields, for narrow columns (the wizard).
    <div className={stacked ? "grid gap-6" : "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"}>
      <div className="min-w-0 space-y-5">
        <div>
          <p className="text-[13px] font-medium muted">Logo</p>
          <div
            className="mt-1 flex items-center gap-4 rounded-xl p-3"
            style={{ border: "1px dashed var(--line)", background: "var(--canvas)" }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              upload(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl" style={{ background: "#fff", border: "1px solid var(--line)" }}>
              {value.logo ? <img src={value.logo} alt="Logo preview" className="h-full w-full object-contain p-1" /> : <span className="faint"><UploadIcon size={20} /></span>}
            </span>
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]" onClick={() => file.current?.click()} disabled={busy}>
                  {busy ? "Preparing…" : value.logo ? "Replace" : "Upload logo"}
                </button>
                {value.logo ? (
                  <button type="button" className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]" onClick={() => onChange({ ...value, logo: "" })}>
                    <CloseIcon size={14} />
                    Remove
                  </button>
                ) : null}
              </div>
              <p className="mt-1.5 faint">PNG, JPG, WebP or SVG, or drop it here. A square logo works best.</p>
            </div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
          </div>
          {err ? (
            <p className="help" style={{ color: "var(--err)" }}>
              {err}
            </p>
          ) : null}
        </div>

        <Field label="Portal name" hint="Shown in the menu and the browser tab. Empty keeps Agent Portal.">
          <input className="field" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} maxLength={40} placeholder="Agent Portal" />
        </Field>

        <div>
          <p className="text-[13px] font-medium muted">Brand colour</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="h-8 w-8 rounded-full transition hover:scale-110"
                style={{ background: p, boxShadow: color === p ? "0 0 0 2px var(--surface), 0 0 0 4px var(--ink)" : "inset 0 0 0 1px rgba(0,0,0,.1)" }}
                onClick={() => setColor(p)}
                aria-label={`Use ${p}`}
                aria-pressed={color === p}
              />
            ))}
            <label className="relative h-8 w-8 cursor-pointer overflow-hidden rounded-full" style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} title="Any colour">
              <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={color || DEFAULT} onChange={(e) => setColor(e.target.value)} aria-label="Pick any colour" />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="field !w-32 font-mono !text-[13px]"
              value={hexText}
              onChange={(e) => {
                const v = e.target.value.trim();
                setHexText(v);
                if (HEX_RE.test(v) || v === "") onChange({ ...value, color: v.toLowerCase() });
              }}
              placeholder={DEFAULT}
              aria-label="Colour as a hex code"
            />
            {suggest && suggest !== color ? (
              <button type="button" className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]" onClick={() => setColor(suggest)}>
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: suggest }} aria-hidden />
                Use the logo&apos;s colour
              </button>
            ) : null}
            {value.color ? (
              <button type="button" className="text-[13px] underline faint" onClick={() => setColor("")}>
                Use the default
              </button>
            ) : null}
          </div>
          {hexText && !HEX_RE.test(hexText) ? <p className="help" style={{ color: "var(--err)" }}>Use a hex code like #1A73E8.</p> : null}
          {notes.map((n) => (
            <p key={n} className="help">
              {n}
            </p>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <p className="text-[13px] font-medium muted">Preview</p>
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          <Preview brand={value} theme="light" />
          <Preview brand={value} theme="dark" />
        </div>
        <p className="help">How their portal will look. Their people can still choose light or dark.</p>
      </div>
    </div>
  );
}

const THEMES = {
  light: { page: "#f6f5f4", surface: "#ffffff", side: "#ffffff", line: "#ebe9e6", ink: "#18181b", faint: "#71717a" },
  dark: { page: "#0f1413", surface: "#161c1b", side: "#0b100f", line: "rgba(255,255,255,.08)", ink: "#e7ecea", faint: "#8a9794" },
};

/** A miniature of the portal in one theme, drawn from the same palette the
 *  portal will use, so what you see here is what they get. */
function Preview({ brand, theme }: { brand: Brand; theme: "light" | "dark" }) {
  const t = THEMES[theme];
  const p = palette(HEX_RE.test(brand.color) ? brand.color : DEFAULT, theme);
  const name = brand.name.trim() || "Agent Portal";
  return (
    <div className="overflow-hidden rounded-xl" style={{ background: t.page, border: `1px solid ${t.line}`, color: t.ink }} aria-label={`${theme} preview`}>
      <div className="flex">
        <div className="w-[46%] shrink-0 space-y-1.5 p-2.5" style={{ background: t.side, borderRight: `1px solid ${t.line}` }}>
          <div className="mb-2 flex items-center gap-1.5">
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md"
              style={brand.logo ? { background: "#fff", boxShadow: `0 0 0 1px ${t.line}` } : { background: `linear-gradient(135deg, ${p["--mark-from"]}, ${p["--mark-to"]})`, color: "#fff" }}
            >
              {brand.logo ? <img src={brand.logo} alt="" className="h-full w-full object-contain p-[2px]" /> : <SparkleIcon size={12} />}
            </span>
            <span className="truncate text-[11px] font-semibold">{name}</span>
          </div>
          <div className="rounded-md px-2 py-1 text-[10px] font-semibold" style={{ background: p["--side-active"], boxShadow: `inset 2px 0 0 ${p["--side-accent"]}` }}>
            Assistants
          </div>
          <div className="px-2 py-1 text-[10px]" style={{ color: t.faint }}>
            My dashboard
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2 p-2.5">
          <div className="rounded-md p-2 text-[10px] font-semibold text-white" style={{ background: `linear-gradient(120deg, ${p["--hero-from"]}, ${p["--hero-to"]})` }}>
            Good morning
          </div>
          <div className="rounded-md p-2" style={{ background: t.surface, border: `1px solid ${t.line}` }}>
            <span className="block text-[10px]" style={{ color: p["--brand"] }}>
              Open assistant
            </span>
            <span
              className="mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: `linear-gradient(180deg, ${p["--btn-from"]}, ${p["--btn-to"]})`, color: p["--btn-ink"] }}
            >
              Ask
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
