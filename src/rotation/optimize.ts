// Exact planner: a small mixed-integer program solved by HiGHS (WebAssembly, runs locally).
// Decision: on which days to start a one-month period for each optional service.
// Objective: fewest missed (episode, follower) pairs first, then the lowest cost.
import loadHighs from "highs";
import { Household, Plan, addMonths, fromDay, toDay, windows } from "./model";

type Highs = Awaited<ReturnType<typeof loadHighs>>;
let highsP: Promise<Highs> | null = null;
const highs = () => (highsP ??= loadHighs());

export interface OptimizeResult {
  plan: Plan;
  status: string;
  objective: number;
  ms: number;
  variables: number;
  constraints: number;
}

export async function optimize(h: Household, opts: { timeLimitSec?: number } = {}): Promise<OptimizeResult> {
  const t0 = Date.now();
  const s0 = toDay(h.start), s1 = toDay(h.end);
  const optional = h.services.filter((s) => !s.required);
  // Missing one pair must always cost more than any possible spending.
  const BIG = optional.reduce((a, s) => a + s.priceCents, 0) * 12 + 1;

  type Cand = { v: string; sid: string; from: number; to: number; price: number };
  const cands: Cand[] = [];
  const existing = new Map<string, number>(); // service -> paid-through day (exclusive)
  for (const s of optional) {
    const paid = s.paidThrough ? Math.max(s0, toDay(s.paidThrough)) : s0;
    if (s.paidThrough) existing.set(s.id, toDay(s.paidThrough));
    for (let d = paid; d <= s1; d++) {
      const start = fromDay(d);
      cands.push({ v: `x_${s.id}_${d - s0}`, sid: s.id, from: d, to: toDay(addMonths(start, 1)), price: s.priceCents });
    }
  }
  const covering = (sid: string, day: number) => cands.filter((c) => c.sid === sid && c.from <= day && day < c.to);
  const hasExisting = (sid: string, day: number) => (existing.get(sid) ?? -Infinity) > day && day >= s0;

  const rows: string[] = [];
  // 1. Never pay twice: at most one period of a service covers any day, and none during already-paid access.
  for (const s of optional) {
    for (let d = s0; d <= s1; d++) {
      const vs = covering(s.id, d);
      if (vs.length > 1) rows.push(`${vs.map((c) => c.v).join(" + ")} <= ${hasExisting(s.id, d) ? 0 : 1}`);
    }
  }
  // 2. Household limit on simultaneous services.
  if (h.maxConcurrent != null) {
    for (let d = s0; d <= s1; d++) {
      const fixed = optional.filter((s) => hasExisting(s.id, d)).length;
      const vs = optional.flatMap((s) => covering(s.id, d));
      // Already-paid access is a fact; if it alone exceeds the limit, no new period may be active that day.
      if (vs.length && fixed + vs.length > h.maxConcurrent) rows.push(`${vs.map((c) => c.v).join(" + ")} <= ${Math.max(0, h.maxConcurrent - fixed)}`);
    }
  }
  // 3. Coverage of each watch window, or pay the miss penalty. Identical windows are merged with a weight.
  const merged = new Map<string, { sid: string; from: number; to: number; weight: number }>();
  for (const w of windows(h)) {
    if (h.services.find((s) => s.id === w.serviceId)!.required) continue;
    const k = `${w.serviceId}|${w.from}|${w.to}`;
    const m = merged.get(k);
    if (m) m.weight++; else merged.set(k, { sid: w.serviceId, from: w.from, to: w.to, weight: 1 });
  }
  const objective: string[] = cands.map((c) => `${c.price} ${c.v}`);
  const misses: string[] = [];
  let i = 0;
  for (const w of merged.values()) {
    let pre = false;
    for (let d = w.from; d <= w.to; d++) if (hasExisting(w.sid, d)) pre = true;
    if (pre) continue;
    const vs = cands.filter((c) => c.sid === w.sid && c.from <= w.to && c.to > w.from);
    const m = `m_${i++}`;
    misses.push(m);
    objective.push(`${BIG * w.weight} ${m}`);
    rows.push(vs.length ? `${vs.map((c) => c.v).join(" + ")} + ${m} >= 1` : `${m} >= 1`);
  }

  const lp = [
    "Minimize",
    ` obj: ${objective.length ? objective.join(" + ") : "0 dummy"}`,
    "Subject To",
    ...rows.map((r, k) => ` c${k}: ${r}`),
    ...(rows.length ? [] : [" c0: dummy >= 0"]),
    "Bounds",
    ...misses.map((m) => ` 0 <= ${m} <= 1`),
    "Binary",
    ` ${cands.map((c) => c.v).join(" ")}`,
    "End",
  ].join("\n");

  const H = await highs();
  const res = H.solve(lp, { output_flag: false, time_limit: opts.timeLimitSec ?? 30, mip_rel_gap: 0 } as any);
  const periods = cands
    .filter((c) => ((res.Columns as any)[c.v]?.Primal ?? 0) > 0.5)
    .map((c) => ({ serviceId: c.sid, start: fromDay(c.from) }));
  return { plan: { periods }, status: res.Status, objective: res.ObjectiveValue, ms: Date.now() - t0, variables: cands.length + misses.length, constraints: rows.length };
}
