"use client";

import { useEffect, useState } from "react";
import { api, LogsResult } from "@/lib/api";
import { ErrorBox, Notice, SectionHead, Spinner } from "./bits";

/** Recent problems the portal hit talking to Databricks, and why.
 *
 *  Problems only: the question an admin brings here is "why did that fail for
 *  someone", and a line per successful request would bury the answer. When a
 *  log table is configured the lines outlive restarts; when it is not, they
 *  come from the running copy's memory and the screen says so, so an empty list
 *  is not read as "nothing ever went wrong".
 */
export function Logs() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<LogsResult | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setErr("");
    api
      .logs(days)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [days, tick]);

  return (
    <div>
      <SectionHead title="Errors and failed calls">
        Recent failures when the portal talked to Databricks, such as someone without permission to
        upload to a folder.
      </SectionHead>

      <div className="card overflow-hidden">
        <div
          className="flex flex-wrap items-center gap-3 px-5 py-4"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          <select
            className="field w-auto text-sm"
            aria-label="Time period"
            value={days}
            onChange={(e) => {
              setData(null);
              setDays(Number(e.target.value));
            }}
          >
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <span className="flex-1" />
          <button type="button" className="btn btn-quiet" onClick={() => setTick(tick + 1)}>
            Refresh
          </button>
        </div>

        <div className="px-5 py-4">
          <ErrorBox>{err}</ErrorBox>
          {data?.note ? (
            <div className="mb-3">
              <Notice>{data.note}</Notice>
            </div>
          ) : null}
          {data === null && !err ? (
            <Spinner label="Loading…" />
          ) : data && data.lines.length === 0 ? (
            <p className="py-2 text-sm muted">No problems recorded in this period.</p>
          ) : (
            <ul>
              {(data?.lines || []).map((l, i) => (
                <li
                  key={i}
                  className="py-2"
                  style={{ borderTop: i ? "1px solid var(--line)" : "none" }}
                >
                  <p className="text-xs faint">
                    <time dateTime={l.at}>{stamp(l.at)}</time>
                    <span className="ml-2 font-semibold" style={{ color: "var(--err)" }}>
                      {l.level}
                    </span>
                  </p>
                  <pre className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed">
                    {l.message}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          {data ? (
            <p className="mt-3 text-xs faint">
              {data.stored
                ? "Saved in a Databricks table, so this survives restarts. Lines can take about 10 seconds to appear."
                : "Only kept in memory for this running copy of the portal; a restart or new deployment clears it."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function stamp(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
