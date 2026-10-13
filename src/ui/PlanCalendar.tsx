"use client";
// Month-by-month rotation calendar for the device screen. When a previous calendar is given, it first shows the old
// plan, then animates to the new one: new paid months grow in green, months that moved or were dropped stay behind
// as red outlines for a moment.
import { useEffect, useRef, useState } from "react";

export type Seg = { key: string; start: string; end: string; kind: "paid" | "plan" | "required"; offset: number; length: number; chargeCents: number };
export type CalRow = { serviceId: string; name: string; priceCents: number; required: boolean; segments: Seg[] };
export type Cal = { start: string; end: string; totalDays: number; months: { key: string; label: string; offset: number; days: number }[]; rows: CalRow[]; version: number };

const pct = (n: number, total: number) => `${(n / total) * 100}%`;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const short = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function PlanCalendar({ cal, prev, animateKey, highlight, compact }: { cal: Cal; prev?: Cal | null; animateKey: string | number; highlight?: string | null; compact?: boolean }) {
  const [phase, setPhase] = useState<"before" | "after">(prev ? "before" : "after");
  useEffect(() => {
    if (!prev) { setPhase("after"); return; }
    setPhase("before");
    const t = setTimeout(() => setPhase("after"), 750);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animateKey]);

  const showing = phase === "before" && prev ? prev : cal;
  const prevKeys = new Set((prev?.rows ?? []).flatMap((r) => r.segments.map((s) => s.key)));
  const curKeys = new Set(cal.rows.flatMap((r) => r.segments.map((s) => s.key)));
  const total = showing.totalDays;

  return (
    <div className={"cal" + (compact ? " compact" : "")} aria-label="Streaming rotation by month">
      <div className="cal-head">
        <span className="cal-label" />
        <div className="cal-track months">
          {showing.months.map((m) => (
            <span key={m.key} className="cal-month" style={{ left: pct(m.offset, total), width: pct(m.days, total) }}>{m.label}</span>
          ))}
        </div>
      </div>
      {showing.rows.map((row) => {
        const after = phase === "after";
        const ghosts = after && prev ? (prev.rows.find((r) => r.serviceId === row.serviceId)?.segments ?? []).filter((s) => !curKeys.has(s.key)) : [];
        return (
          <div key={row.serviceId} className={"cal-row" + (highlight && highlight !== row.serviceId ? " dim" : "") + (highlight === row.serviceId ? " hl" : "")}>
            <span className="cal-label">
              <b>{row.name}</b>
              <small>{row.required ? "always on" : `${money(row.priceCents)}/mo`}</small>
            </span>
            <div className="cal-track">
              {showing.months.map((m) => <i key={m.key} className="cal-grid" style={{ left: pct(m.offset, total) }} />)}
              {ghosts.map((s) => (
                <span key={"g" + s.key} className="seg ghost" style={{ left: pct(s.offset, total), width: pct(s.length, total) }} title={`Was: ${short(s.start)} to ${short(s.end)}`} />
              ))}
              {row.segments.length === 0 && phase === "after" && !ghosts.length && <span className="seg-off">off</span>}
              {row.segments.map((s) => {
                const added = after && prev && !prevKeys.has(s.key);
                return (
                  <span
                    key={s.key}
                    className={`seg ${s.kind}${added ? " added" : ""}`}
                    style={{ left: pct(s.offset, total), width: `calc(${pct(s.length, total)} - 2px)` }}
                    title={`${row.name}: ${short(s.start)} to ${short(s.end)}${s.kind === "paid" ? " (already paid)" : `, ${money(s.chargeCents)}`}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      {!compact && (
        <div className="cal-legend">
          <span><i className="sw paid" />Already paid</span>
          <span><i className="sw plan" />One paid month</span>
          <span><i className="sw added" />New</span>
          <span><i className="sw ghost" />Moved or dropped</span>
        </div>
      )}
    </div>
  );
}

/** Counts from one amount to another, so a re-plan's cost change is visible. */
export function MoneyTicker({ from, to, delayMs = 750 }: { from: number | null; to: number; delayMs?: number }) {
  const [v, setV] = useState(from ?? to);
  const raf = useRef(0);
  useEffect(() => {
    if (from == null || from === to) { setV(to); return; }
    setV(from);
    let t0 = 0;
    const timer = setTimeout(() => {
      const step = (t: number) => {
        if (!t0) t0 = t;
        const k = Math.min(1, (t - t0) / 900);
        const e = 1 - Math.pow(1 - k, 3);
        setV(Math.round(from + (to - from) * e));
        if (k < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }, delayMs);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf.current); };
  }, [from, to, delayMs]);
  return <>{money(v)}</>;
}
