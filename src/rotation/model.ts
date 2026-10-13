// Season Pass: the household streaming rotation problem, its rules, and a scorer for any plan.
// DEMO DATA ONLY: every service, show and family in this project is fictional.

export interface Service {
  id: string;
  name: string;
  priceCents: number; // per one-month period
  /** The family keeps this one on no matter what (for example the kids' service). Renewed automatically, outside the cap. */
  required: boolean;
  /** If currently subscribed: access is already paid until this date (exclusive). It renews on this date unless turned off. */
  paidThrough: string | null;
}

export interface Member {
  id: string;
  name: string;
  /** Watches a new episode within this many days of release (spoiler tolerance). */
  watchWithinDays: number;
}

export interface Title {
  id: string;
  name: string;
  serviceId: string;
  kind: "weekly" | "drop" | "leaving";
  followers: string[];
  /** Episode release dates. For "leaving" titles: one entry, the date it is already available from. */
  episodes: { n: number; release: string }[];
  /** For "leaving" titles: last day it can be watched. */
  availableUntil?: string;
}

export interface Household {
  id: string;
  name: string;
  start: string; // first day of the plan (inclusive)
  end: string; // last day of the plan (inclusive)
  /** At most this many non-required services active on any day (household rule). null = no limit. */
  maxConcurrent: number | null;
  services: Service[];
  members: Member[];
  titles: Title[];
}

/** One paid month: access from `start` (inclusive) to the same day next month (exclusive). */
export interface Period {
  serviceId: string;
  start: string;
}

export interface Plan {
  periods: Period[];
}

// ---------- dates (UTC, ISO day strings) ----------

const DAY = 86400000;
export const toDay = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / DAY);
export const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromDay(toDay(iso) + n);
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export const isIsoDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z")) && fromDay(toDay(s)) === s;

/** Access interval of a period as day numbers [from, to). */
export const periodSpan = (p: Period): [number, number] => [toDay(p.start), toDay(addMonths(p.start, 1))];

// ---------- the watch windows the plan must cover ----------

export interface Window {
  titleId: string;
  serviceId: string;
  episode: number;
  memberId: string;
  from: number; // day, inclusive
  to: number; // day, inclusive
}

export function windows(h: Household): Window[] {
  const out: Window[] = [];
  const s0 = toDay(h.start), s1 = toDay(h.end);
  for (const t of h.titles) {
    for (const e of t.episodes) {
      for (const m of t.followers) {
        const mem = h.members.find((x) => x.id === m)!;
        const from = Math.max(s0, toDay(e.release));
        const to = Math.min(s1, t.kind === "leaving" ? toDay(t.availableUntil!) : toDay(e.release) + mem.watchWithinDays);
        if (from <= to) out.push({ titleId: t.id, serviceId: t.serviceId, episode: e.n, memberId: m, from, to });
      }
    }
  }
  return out;
}

// ---------- scoring any plan, from any source ----------

export interface Violation {
  rule: "unknown_service" | "bad_date" | "outside_plan" | "required_listed" | "double_paid" | "over_cap";
  detail: string;
}

export interface Score {
  costCents: number; // optional services + required renewals
  missed: number; // (episode, follower) pairs that could not be watched in time
  missedByTitle: Record<string, number>;
  violations: Violation[];
  periodsCounted: number;
}

/** Required services: renewed on every billing day through the end of the plan. Same for every planner. */
export function requiredPeriods(h: Household): Period[] {
  const out: Period[] = [];
  for (const s of h.services.filter((x) => x.required)) {
    let d = s.paidThrough ?? h.start;
    while (d <= h.end) { out.push({ serviceId: s.id, start: d }); d = addMonths(d, 1); }
  }
  return out;
}

export function score(h: Household, plan: Plan): Score {
  const violations: Violation[] = [];
  const s0 = toDay(h.start), s1 = toDay(h.end);
  const valid: Period[] = [];
  for (const p of plan.periods ?? []) {
    const svc = h.services.find((s) => s.id === p?.serviceId);
    if (!svc) { violations.push({ rule: "unknown_service", detail: String(p?.serviceId) }); continue; }
    if (!isIsoDay(p.start)) { violations.push({ rule: "bad_date", detail: `${p.serviceId} ${p.start}` }); continue; }
    if (svc.required) { violations.push({ rule: "required_listed", detail: `${svc.id} is renewed automatically; listing it pays twice` }); continue; }
    const d = toDay(p.start);
    if (d < s0 || d > s1) { violations.push({ rule: "outside_plan", detail: `${svc.id} ${p.start}` }); continue; }
    valid.push(p);
  }
  // Paying twice for the same days: overlapping periods, or a new period before the current paid access ends.
  const byService = new Map<string, [number, number][]>();
  for (const s of h.services) {
    const spans: [number, number][] = [];
    if (s.paidThrough && toDay(s.paidThrough) > s0) spans.push([s0, toDay(s.paidThrough)]);
    byService.set(s.id, spans);
  }
  for (const p of [...valid].sort((a, b) => a.start.localeCompare(b.start))) {
    const spans = byService.get(p.serviceId)!;
    const [a, b] = periodSpan(p);
    const clash = spans.find(([x, y]) => a < y && x < b);
    if (clash) violations.push({ rule: "double_paid", detail: `${p.serviceId} ${p.start} overlaps access already paid until ${fromDay(clash[1])}` });
    spans.push([a, b]);
  }
  for (const p of requiredPeriods(h)) byService.get(p.serviceId)!.push(periodSpan(p));

  const active = (sid: string, day: number) => byService.get(sid)!.some(([x, y]) => day >= x && day < y);
  if (h.maxConcurrent != null) {
    let inBreach = false;
    for (let d = s0; d <= s1; d++) {
      const n = h.services.filter((s) => !s.required && active(s.id, d)).length;
      const prepaid = h.services.filter((s) => !s.required && s.paidThrough && d < toDay(s.paidThrough)).length;
      const limit = Math.max(h.maxConcurrent, prepaid);
      if (n > limit && !inBreach) violations.push({ rule: "over_cap", detail: `${n} services on ${fromDay(d)}, limit ${h.maxConcurrent}` });
      inBreach = n > limit;
    }
  }
  let missed = 0;
  const missedByTitle: Record<string, number> = {};
  for (const w of windows(h)) {
    let ok = false;
    for (let d = w.from; d <= w.to && !ok; d++) ok = active(w.serviceId, d);
    if (!ok) { missed++; missedByTitle[w.titleId] = (missedByTitle[w.titleId] ?? 0) + 1; }
  }
  const all = [...valid, ...requiredPeriods(h)];
  const costCents = all.reduce((sum, p) => sum + h.services.find((s) => s.id === p.serviceId)!.priceCents, 0);
  return { costCents, missed, missedByTitle, violations, periodsCounted: all.length };
}

/** The rules in plain English, shared by the docs, the assistant and the pure-model baseline. */
export const RULES_TEXT = `Rules for a valid plan:
1. A plan is a list of paid periods. Each period is one service and a start date. It gives access from the start date (inclusive) to the same day of the next month (exclusive), and costs that service's monthly price.
2. A service with paidThrough set is already paid until that date (exclusive) at no extra cost. To keep it after that, add a period starting on or after paidThrough. Doing nothing turns it off on paidThrough.
3. Never pay twice: periods of the same service must not overlap each other or the already-paid access.
4. Every period must start between the plan start and plan end dates (inclusive).
5. Services marked required are renewed automatically for the whole plan and do not count toward the limit. Do not list them.
6. If maxConcurrent is set, on no day may more than that many non-required services have access (paid periods and already-paid access both count). If already-paid access alone exceeds the limit on some day, no new period may give access on that day.
7. An episode counts as watched in time for a follower if the service has access on at least one day from its release date through release date plus that follower's watchWithinDays (both inclusive). For a "leaving" title, the window is from its release date through availableUntil. Windows are clipped to the plan dates.
Goal: first, miss as few (episode, follower) pairs as possible; second, spend as little as possible.`;
