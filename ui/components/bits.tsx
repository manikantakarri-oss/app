"use client";

import { ReactNode, useEffect, useState } from "react";
import { SearchIcon } from "./icons";

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
