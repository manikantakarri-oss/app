"use client";

import { ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./icons";

/** Page through a list. Resets to the first page whenever `reset` changes
 *  (a new filter, search or period), and never points past the last page. */
export function usePage<T>(items: T[], size: number, reset: unknown[] = []) {
  const [page, setPage] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPage(0), reset);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, pages - 1);
  return { rows: items.slice(p * size, (p + 1) * size), page: p, pages, setPage, total: items.length, size };
}

/** The one pager every table and list uses: "1–25 of 230" and Previous/Next.
 *  Renders nothing when everything fits on one page. */
export function Pager({ pg, noun = "items" }: { pg: ReturnType<typeof usePage<any>>; noun?: string }) {
  if (pg.total <= pg.size) return null;
  const from = pg.page * pg.size + 1;
  const to = Math.min(pg.total, from + pg.size - 1);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-2.5 text-xs faint" style={{ borderColor: "var(--line)" }}>
      <span className="tabular-nums">
        {from.toLocaleString()}–{to.toLocaleString()} of {pg.total.toLocaleString()} {noun}
      </span>
      <span className="flex items-center gap-2">
        <button type="button" className="btn btn-quiet !min-h-[30px] !px-2.5 !text-[12px]" disabled={pg.page === 0} onClick={() => pg.setPage(pg.page - 1)}>
          Previous
        </button>
        <span className="tabular-nums">
          Page {pg.page + 1} of {pg.pages}
        </span>
        <button type="button" className="btn btn-quiet !min-h-[30px] !px-2.5 !text-[12px]" disabled={pg.page >= pg.pages - 1} onClick={() => pg.setPage(pg.page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}

/** A card list that stays usable at any size: a search box once the list is
 *  long, the first `page` cards, and a "Show more" button for the rest.
 *  Purely presentational - it renders the same cards with the same handlers. */
export function CardList<T>({
  items,
  render,
  keyOf,
  text,
  noun = "items",
  page = 12,
  searchFrom = 9,
  className = "card-grid",
}: {
  items: T[];
  render: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  /** Words to match the search against (name, description...). */
  text: (item: T) => string;
  noun?: string;
  page?: number;
  searchFrom?: number;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(page);
  useEffect(() => setLimit(page), [q, page]);

  const s = q.trim().toLowerCase();
  const hits = s ? items.filter((i) => text(i).toLowerCase().includes(s)) : items;
  const shown = hits.slice(0, limit);
  const rest = hits.length - shown.length;

  return (
    <div>
      {items.length >= searchFrom ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="field flex max-w-sm items-center gap-2 !py-0">
            <span className="faint">
              <SearchIcon size={16} />
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${items.length} ${noun}`}
              aria-label={`Search ${noun}`}
              className="min-h-[42px] w-full bg-transparent outline-none"
            />
          </label>
          {s ? (
            <span className="text-sm faint" aria-live="polite">
              {hits.length} of {items.length}
            </span>
          ) : null}
        </div>
      ) : null}

      {hits.length === 0 ? (
        <p className="text-sm muted">
          No {noun} match “{q}”.{" "}
          <button type="button" className="underline" onClick={() => setQ("")}>
            Clear the search
          </button>
        </p>
      ) : (
        <div className={className}>
          {shown.map((i) => (
            <div key={keyOf(i)} className="flex min-w-0">
              {render(i)}
            </div>
          ))}
        </div>
      )}

      {rest > 0 ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button type="button" className="btn btn-quiet" onClick={() => setLimit((l) => l + page)}>
            Show {Math.min(rest, page)} more
          </button>
          {rest > page ? (
            <button type="button" className="btn btn-quiet" onClick={() => setLimit(hits.length)}>
              Show all {hits.length}
            </button>
          ) : null}
          <span className="w-full text-center text-xs faint">
            Showing {shown.length} of {hits.length} {noun}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm muted">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      {label}
    </span>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="error whitespace-pre-wrap" role="alert">
      {children}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="notice">{children}</div>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1.5 text-sm muted">{hint}</p> : null}
    </div>
  );
}

export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="tag" title={title}>
      {children}
    </span>
  );
}

/** A ready/not-ready dot. Colour alone never carries the meaning - the label
 *  next to it says the same thing in words. */
export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className="h-2 w-2 rounded-full"
      style={{ background: ok ? "var(--ok)" : "var(--ink-faint)" }}
    />
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {children ? <p className="mt-1 text-sm muted max-w-2xl">{children}</p> : null}
    </div>
  );
}

/** Fetch a list for a dropdown and say whether it is still on its way.
 *  `load` is null while there is nothing to fetch yet (e.g. no catalog
 *  chosen). A reply that arrives after the inputs changed is dropped, so a
 *  slow answer for an old choice never replaces the current list. */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (!load) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading, error };
}

export type SelectOption = {
  value: string;
  label: string;
  /** A second, quieter line (a description). Never widens the list. */
  detail?: string;
  disabled?: boolean;
  /** Short reason shown on the right of a disabled option, e.g. "Added". */
  note?: string;
};

/** The one dropdown every form uses, in place of the browser's own `<select>`.
 *
 *  The browser draws a native list as wide as its longest option and ignores
 *  the theme, so a long description ran far past the form (seen with app
 *  descriptions). This list is exactly as wide as its field, cuts long names
 *  with "…" (full text on hover), puts descriptions on a second line, follows
 *  light/dark, and gets a search box once there are more than 8 options. It is
 *  rendered at the end of the page and positioned against the window, so a
 *  card with `overflow-hidden` never clips it, and opens upwards when there is no room below. Keyboard: arrows,
 *  Home/End, Enter, Escape.
 *
 *  `loading` (the options are still being fetched) shows a spinner and
 *  "Loading…" and keeps it shut; once loaded with nothing to offer it says
 *  `empty` instead of opening an empty list. Pair it with `useLoad`. */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  disabled,
  className = "",
  ariaLabel,
  searchFrom = 9,
  loading = false,
  empty = "Nothing found",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  searchFrom?: number;
  loading?: boolean;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number; max: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const chosen = options.find((o) => o.value === value);
  const none = !loading && !disabled && options.length === 0;
  const shut = disabled || loading || none;
  const label = loading ? "Loading…" : chosen ? chosen.label : none ? empty : placeholder;
  const searchable = options.length >= searchFrom;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => (o.label + " " + (o.detail || "") + " " + o.value).toLowerCase().includes(needle))
    : options;

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 240 && above > below;
    const max = Math.max(160, Math.min(340, up ? above : below));
    setBox(
      up
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4, max }
        : { left: r.left, width: r.width, top: r.bottom + 4, max },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = (e: Event) => {
      if (list.current && e.target instanceof Node && list.current.contains(e.target)) return;
      place();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    if (searchable) setTimeout(() => search.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (shut) setOpen(false);
  }, [shut]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(o: SelectOption | undefined) {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btn.current?.focus();
  }

  function step(from: number, dir: 1 | -1) {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
    return from;
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (e.key === "Home" && !searchable) {
      e.preventDefault();
      setActive(step(-1, 1));
    } else if (e.key === "End" && !searchable) {
      e.preventDefault();
      setActive(step(shown.length, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`field select-btn ${className}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        disabled={shut}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        title={chosen ? chosen.label + (chosen.detail ? " — " + chosen.detail : "") : undefined}
      >
        <span className={`min-w-0 flex-1 truncate text-left ${chosen && !loading ? "" : "faint"}`}>{label}</span>
        {loading ? (
          <span aria-hidden className="select-spin h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <ChevronDownIcon size={16} />
        )}
      </button>
      {/* In a portal: inside the field's <label>, a click on an option would
          also "click" the field and open the list again. */}
      {open && box ? createPortal(
        <div
          ref={list}
          className="select-pop"
          style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.max }}
          onKeyDown={onKey}
        >
          {searchable ? (
            <div className="select-search">
              <SearchIcon size={15} />
              <input
                ref={search}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder={`Search ${options.length.toLocaleString()} options`}
                aria-label="Search the options"
                aria-controls={id}
              />
            </div>
          ) : null}
          <div id={id} role="listbox" className="select-list" tabIndex={-1}>
            {shown.length === 0 ? (
              <p className="px-3 py-3 text-[13px] faint">
                {options.length ? `Nothing matches “${q.trim()}”.` : "Nothing to choose from."}
              </p>
            ) : null}
            {shown.map((o, i) => (
              <div
                key={o.value}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active || undefined}
                className="select-opt"
                title={o.label + (o.detail ? " — " + o.detail : "")}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{o.label}</span>
                  {o.detail ? <span className="line-clamp-2 text-[12.5px] leading-[1.35] faint">{o.detail}</span> : null}
                </span>
                {o.note ? <span className="shrink-0 text-[12px] faint">{o.note}</span> : null}
                {o.value === value ? (
                  <span className="shrink-0" style={{ color: "var(--brand)" }}>
                    <CheckIcon size={15} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
