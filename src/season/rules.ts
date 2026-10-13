// Season Pass rules. Planning, money and confirmations are decided here, in plain code. A conversation layer
// (scripted rules now, Claude later) can only call these through MCP tools; it can never invent an amount,
// a date, or a yes.
import { Household, Period, Plan, Title, Window, addDays, addMonths, fromDay, requiredPeriods, score, toDay, windows } from "../rotation/model";
import { optimize } from "../rotation/optimize";
import { cleanSpeech, listWords, screenMoney, shortDate, spokenDate, spokenMoney } from "./speech";
import {
  ActionKind, CallContext, LedgerEntry, PlanSnapshot, Preference, PreferenceKind, Proposal, Reminder, RuleError, SPMember, SPService,
  SeasonState, ServiceSnapshot, SwitchAction,
} from "./types";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
/** A switch proposal bundles the plan's actions in this many days. */
export const PROPOSAL_WINDOW_DAYS = 10;
/** The morning briefing speaks up when a billing day or a switch is this close. */
export const BRIEFING_NOTICE_DAYS = 3;

/** An Echo Show style card: one title, at most two fields, at most one action. */
export interface Card {
  kind: "briefing" | "plan" | "explain" | "confirm" | "receipt" | "reminder" | "household" | "blocked";
  title: string;
  fields: { label: string; value: string }[];
  /** What a tap does: say the utterance, or (confirm/undo) call the MCP tool directly as the person who tapped. */
  action?: { label: string; utterance: string; tool?: { name: string; arguments: Record<string, unknown> } };
  tone?: "neutral" | "good" | "warn";
  footnote?: string;
}

// ---------- lookups ----------

function nextId(state: SeasonState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+ ]/g, " ").replace(/\bthe\b/g, " ").replace(/\s+/g, " ").trim();

export function getMember(state: SeasonState, idOrName: string | null | undefined): SPMember | null {
  if (!idOrName) return null;
  const k = norm(idOrName);
  return state.members.find((m) => m.id === k || norm(m.name) === k || m.aliases.some((a) => norm(a) === k)) ?? null;
}

export function getService(state: SeasonState, idOrName: string): SPService {
  const k = norm(idOrName);
  const s = state.services.find((x) => x.id === k || norm(x.name) === k)
    ?? state.services.find((x) => x.tags.some((t) => norm(t) === k))
    ?? state.services.find((x) => k.length >= 3 && (norm(x.name).startsWith(k) || x.tags.some((t) => k.includes(norm(t)))));
  if (!s) throw new RuleError("unknown_service", `I don't know a service called ${idOrName}. This household has ${listWords(state.services.map((x) => x.name))}.`);
  return s;
}

export function getTitle(state: SeasonState, idOrName: string): Title {
  const k = norm(idOrName);
  const t = state.titles.find((x) => x.kind !== "request" && (x.id === k || norm(x.name) === k))
    ?? state.titles.find((x) => x.kind !== "request" && k.length >= 4 && (norm(x.name).includes(k) || k.includes(norm(x.name))));
  if (!t) throw new RuleError("unknown_title", `I don't know a show called ${idOrName}. Shows on the plan: ${listWords(state.titles.filter((x) => x.kind !== "request").map((x) => x.name))}.`);
  return t;
}

const svcName = (state: SeasonState, id: string) => state.services.find((s) => s.id === id)?.name ?? id;
const memName = (state: SeasonState, id: string) => state.members.find((m) => m.id === id)?.name ?? id;
const approvers = (state: SeasonState) => listWords(state.members.filter((m) => m.billingAuthority).map((m) => m.name)).replace(" and ", " or ");

/** "today", "tomorrow", "Thursday" within a week, otherwise "November 12". */
export function when(today: string, date: string): string {
  const n = toDay(date) - toDay(today);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1 && n < 7) return spokenDate(date).split(",")[0];
  return spokenDate(date).split(", ")[1];
}

// ---------- the planner's view of the household ----------

export function toHousehold(state: SeasonState): Household {
  return {
    id: state.householdId,
    name: state.householdName,
    start: state.today,
    end: state.horizonEnd,
    maxConcurrent: state.maxConcurrent,
    services: state.services.map((s) => ({ id: s.id, name: s.name, priceCents: s.priceCents, required: s.required, paidThrough: s.paidThrough && s.paidThrough > state.today ? s.paidThrough : null })),
    members: state.members.map((m) => ({ id: m.id, name: m.name, watchWithinDays: m.watchWithinDays })),
    titles: state.titles,
  };
}

function keepAllOn(h: Household): Plan {
  const periods: Period[] = [];
  for (const s of h.services.filter((x) => !x.required)) {
    let d = s.paidThrough ?? h.start;
    while (d <= h.end) { periods.push({ serviceId: s.id, start: d }); d = addMonths(d, 1); }
  }
  return { periods };
}

/** Recomputes the cheapest rotation that misses nothing it doesn't have to. Exact; usually about 0.1 seconds. */
export async function replan(state: SeasonState, cause: string): Promise<{ before: PlanSnapshot | null; after: PlanSnapshot }> {
  const h = toHousehold(state);
  const o = await optimize(h, { prefer: state.plan?.periods });
  const sc = score(h, o.plan);
  if (sc.violations.length) throw new Error(`planner produced an invalid plan: ${sc.violations.map((v) => v.rule).join(", ")}`);
  const before = state.plan;
  state.plan = {
    version: state.inputsVersion, computedOn: state.today, horizonEnd: state.horizonEnd,
    periods: [...o.plan.periods].sort((a, b) => a.start.localeCompare(b.start) || a.serviceId.localeCompare(b.serviceId)),
    costCents: sc.costCents, missed: sc.missed, missedByTitle: sc.missedByTitle, pairs: windows(h).length,
    solverMs: o.ms, solverStatus: o.status, keepAllOnCents: score(h, keepAllOn(h)).costCents, cause,
  };
  return { before, after: state.plan };
}

export async function ensurePlan(state: SeasonState): Promise<PlanSnapshot> {
  if (!state.plan || state.plan.version !== state.inputsVersion || state.plan.computedOn !== state.today) await replan(state, "refresh");
  return state.plan!;
}

// ---------- access spans, coverage and explanations ----------

export interface Span { serviceId: string; from: number; to: number; kind: "paid" | "plan" | "required"; start: string }

export function spans(state: SeasonState, plan: PlanSnapshot): Span[] {
  const h = toHousehold(state);
  const out: Span[] = [];
  for (const s of h.services) if (s.paidThrough && !s.required) out.push({ serviceId: s.id, from: toDay(h.start), to: toDay(s.paidThrough), kind: "paid", start: h.start });
  for (const p of plan.periods) out.push({ serviceId: p.serviceId, from: toDay(p.start), to: toDay(addMonths(p.start, 1)), kind: "plan", start: p.start });
  for (const p of requiredPeriods(h)) out.push({ serviceId: p.serviceId, from: toDay(p.start), to: toDay(addMonths(p.start, 1)), kind: "required", start: p.start });
  return out;
}

interface Purpose { titleId: string; episodes: number[]; members: string[] }

/** Which followed episodes each access span is for. Each (episode, follower) is credited to the first span that covers it. */
export function attribute(state: SeasonState, plan: PlanSnapshot) {
  const sp = spans(state, plan).sort((a, b) => a.from - b.from);
  const bySpan = new Map<Span, Map<string, Purpose>>();
  const missed: Window[] = [];
  for (const w of windows(toHousehold(state))) {
    const hit = sp.find((s) => s.serviceId === w.serviceId && s.from <= w.to && s.to > w.from);
    if (!hit) { missed.push(w); continue; }
    const m = bySpan.get(hit) ?? new Map<string, Purpose>();
    const p = m.get(w.titleId) ?? { titleId: w.titleId, episodes: [], members: [] };
    if (!p.episodes.includes(w.episode)) p.episodes.push(w.episode);
    if (!p.members.includes(w.memberId)) p.members.push(w.memberId);
    m.set(w.titleId, p);
    bySpan.set(hit, m);
  }
  return { spans: sp, purposes: (s: Span) => [...(bySpan.get(s)?.values() ?? [])], missed };
}

function episodesText(eps: number[], total: number): string {
  const e = [...eps].sort((a, b) => a - b);
  if (total === 1) return "";
  if (e.length === total) return "all episodes";
  if (e.length === 1) return `episode ${e[0]}`;
  const contiguous = e[e.length - 1] - e[0] === e.length - 1;
  return contiguous ? `episodes ${e[0]} to ${e[e.length - 1]}` : `${e.length} episodes`;
}

export function purposeText(state: SeasonState, ps: Purpose[]): string {
  if (!ps.length) return "nothing anyone follows";
  return listWords(ps.slice(0, 2).map((p) => {
    const t = state.titles.find((x) => x.id === p.titleId)!;
    if (t.kind === "request") return `${listWords(p.members.map((m) => memName(state, m)))}'s request`;
    const eps = episodesText(p.episodes, t.episodes.length);
    return `${t.name}${eps ? ` ${eps}` : ""} for ${listWords(p.members.map((m) => memName(state, m)))}`;
  }));
}

/** Followed shows on a service that keep releasing after `date` but that nobody follows any more. */
function unfollowedAfter(state: SeasonState, serviceId: string, date: string): Title[] {
  return state.titles.filter((t) => t.serviceId === serviceId && t.kind !== "request" && t.followers.length === 0 && t.episodes.some((e) => e.release >= date));
}

function lastNeeded(state: SeasonState, serviceId: string, before: string): Title[] {
  return state.titles.filter((t) => t.serviceId === serviceId && t.followers.length > 0 && t.kind !== "request"
    && t.episodes.some((e) => e.release < before && e.release >= addDays(state.today, -14)) && !t.episodes.some((e) => e.release >= before));
}

export function explainService(state: SeasonState, plan: PlanSnapshot, serviceId: string) {
  const svc = state.services.find((s) => s.id === serviceId)!;
  const a = attribute(state, plan);
  const mine = a.spans.filter((s) => s.serviceId === serviceId);
  const lines = mine.map((s) => ({
    from: fromDay(s.from), to: fromDay(Math.min(s.to, toDay(plan.horizonEnd) + 1)), kind: s.kind,
    chargeCents: s.kind === "paid" ? 0 : svc.priceCents, forWhat: purposeText(state, a.purposes(s)),
  }));
  const missed = a.missed.filter((w) => w.serviceId === serviceId).length;
  let speech: string;
  if (svc.required) speech = `${svc.name} stays on every month. The family marked it as always on.`;
  else if (!lines.length) speech = `${svc.name} stays off through ${spokenDate(plan.horizonEnd).split(", ")[1]}: nobody follows anything new on it.${unfollowedAfter(state, serviceId, state.today).length ? ` ${listWords(unfollowedAfter(state, serviceId, state.today).map((t) => t.name))} has no followers right now.` : ""}`;
  else {
    const parts = lines.slice(0, 3).map((l, i) => l.kind === "paid"
      ? `already paid until ${when(state.today, l.to)}, for ${l.forWhat}.`
      : `${i === 0 ? "on" : "Then on"} ${spokenDate(l.from).split(", ")[1]} for ${l.forWhat}.`);
    speech = `${svc.name} is ${parts.join(" ")}`;
    const off = lines.filter((l) => l.kind !== "required");
    if (off.length && !unfollowedAfter(state, serviceId, state.today).length) speech += ` Off the rest of the time.`;
    else if (off.length) speech += ` Off otherwise: nobody follows ${listWords(unfollowedAfter(state, serviceId, state.today).map((t) => t.name))} right now.`;
  }
  if (missed) speech += ` ${missed} followed episodes on it don't fit under the limit of ${state.maxConcurrent} at a time.`;
  return { service: svc.name, periods: lines, missed, speech: cleanSpeech(speech) };
}

// ---------- calendar for the screen ----------

export function calendar(state: SeasonState, plan: PlanSnapshot) {
  const start = toDay(plan.computedOn), end = toDay(plan.horizonEnd) + 1;
  const months: { key: string; label: string; offset: number; days: number }[] = [];
  let m = plan.computedOn.slice(0, 8) + "01";
  while (toDay(m) < end) {
    const from = Math.max(start, toDay(m)), to = Math.min(end, toDay(addMonths(m, 1)));
    months.push({ key: m.slice(0, 7), label: new Date(m + "T12:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }), offset: from - start, days: to - from });
    m = addMonths(m, 1);
  }
  const sp = spans(state, plan);
  const rows = state.services.map((s) => ({
    serviceId: s.id, name: s.name, priceCents: s.priceCents, required: s.required,
    segments: sp.filter((x) => x.serviceId === s.id && x.from < end).map((x) => ({
      key: `${s.id}:${x.kind}:${x.start}`, start: fromDay(x.from), end: fromDay(Math.min(x.to, end)), kind: x.kind,
      offset: x.from - start, length: Math.min(x.to, end) - x.from, chargeCents: x.kind === "paid" ? 0 : s.priceCents,
    })),
  }));
  return { start: plan.computedOn, end: plan.horizonEnd, totalDays: end - start, months, rows, version: plan.version };
}

export type Calendar = ReturnType<typeof calendar>;

function coverageText(plan: PlanSnapshot) {
  return plan.missed === 0 ? `all ${plan.pairs}` : `${plan.pairs - plan.missed} of ${plan.pairs}`;
}

function horizonWords(plan: PlanSnapshot) {
  return `through ${spokenDate(plan.horizonEnd).split(", ")[1].split(" ")[0]}`;
}

export function planSummary(state: SeasonState, plan: PlanSnapshot) {
  return {
    version: plan.version, from: plan.computedOn, through: plan.horizonEnd, periods: plan.periods,
    cost: screenMoney(plan.costCents), costCents: plan.costCents, keepAllOnCents: plan.keepAllOnCents,
    savesVsKeepingAllOnCents: plan.keepAllOnCents - plan.costCents,
    followedEpisodes: plan.pairs, missedEpisodes: plan.missed,
    missedByTitle: Object.fromEntries(Object.entries(plan.missedByTitle).map(([k, v]) => [state.titles.find((t) => t.id === k)?.name ?? k, v])),
    solver: { name: "HiGHS mixed-integer program (exact)", ms: plan.solverMs, status: plan.solverStatus }, cause: plan.cause,
  };
}

function planCard(state: SeasonState, plan: PlanSnapshot, title: string, deltaCents?: number): Card {
  return {
    kind: "plan",
    title,
    fields: [
      { label: `Cost ${horizonWords(plan)}`, value: deltaCents ? `${screenMoney(plan.costCents)} (${deltaCents > 0 ? "+" : "-"}${screenMoney(Math.abs(deltaCents))})` : screenMoney(plan.costCents) },
      { label: "Followed episodes in time", value: coverageText(plan) },
    ],
    tone: plan.missed ? "warn" : "good",
    footnote: `Exact solver (HiGHS), ${plan.solverMs} ms. Keeping every service on would cost ${screenMoney(plan.keepAllOnCents)}.`,
  };
}

export async function planRotation(state: SeasonState) {
  const { after } = await replan(state, "asked for the plan");
  const next = nextActions(state, after, PROPOSAL_WINDOW_DAYS).filter((a) => !a.alreadySet);
  const save = after.keepAllOnCents - after.costCents;
  const speech = `Here's the cheapest rotation ${horizonWords(after)}: ${spokenMoney(after.costCents)} for the household, ${after.missed ? `${after.missed} followed episodes don't fit under your limit` : "every followed episode in time"}. That's ${spokenMoney(save)} less than keeping every service on.${next[0] ? ` Next: ${actionWords(state, next[0])}.` : ""}`;
  return { plan: planSummary(state, after), calendar: calendar(state, after), nextActions: next, card: planCard(state, after, "Your streaming rotation"), speech: cleanSpeech(speech) };
}

// ---------- actions the plan implies ----------

/** What the plan says to do with each service in the next `withinDays` days, compared with how it is set up now. */
export function nextActions(state: SeasonState, plan: PlanSnapshot, withinDays: number): SwitchAction[] {
  const horizon = addDays(state.today, withinDays);
  const a = attribute(state, plan);
  const out: SwitchAction[] = [];
  for (const s of state.services.filter((x) => !x.required)) {
    const mine = plan.periods.filter((p) => p.serviceId === s.id).sort((x, y) => x.start.localeCompare(y.start));
    const paid = s.paidThrough && s.paidThrough > state.today ? s.paidThrough : null;
    const forPeriod = (start: string) => {
      const sp = a.spans.find((x) => x.serviceId === s.id && x.kind === "plan" && x.start === start);
      return sp ? purposeText(state, a.purposes(sp)) : "the plan";
    };
    if (paid && paid <= horizon) {
      const renewed = mine.find((p) => p.start === paid);
      if (renewed) {
        out.push({ serviceId: s.id, kind: "keep", date: paid, amountCents: s.priceCents, alreadySet: s.autoRenew, why: `Needed for ${forPeriod(paid)}.` });
      } else {
        const done = lastNeeded(state, s.id, paid).map((t) => `${t.name} ends ${when(state.today, t.episodes[t.episodes.length - 1].release)}`);
        const idle = unfollowedAfter(state, s.id, paid).map((t) => `nobody is following ${t.name}`);
        const back = mine[0] ? `It comes back on ${shortDate(mine[0].start)} for ${forPeriod(mine[0].start)}.` : "";
        out.push({ serviceId: s.id, kind: "turn_off", date: paid, amountCents: s.priceCents, alreadySet: !s.autoRenew,
          why: `${[...done, ...idle].length ? listWords([...done, ...idle]) + "." : "Nothing followed needs it next month."} ${back}`.trim() });
      }
    }
    if (!paid || mine.some((p) => p.start > paid)) {
      const first = mine.find((p) => !paid || p.start > paid);
      if (first && first.start <= horizon) {
        out.push({ serviceId: s.id, kind: "turn_on", date: first.start, amountCents: s.priceCents, alreadySet: s.scheduledStart === first.start, why: `For ${forPeriod(first.start)}.` });
      } else if (s.scheduledStart && s.scheduledStart <= horizon && (!first || first.start !== s.scheduledStart)) {
        out.push({ serviceId: s.id, kind: "cancel_start", date: s.scheduledStart, amountCents: 0, alreadySet: false, why: first ? `The plan now starts it on ${shortDate(first.start)} instead.` : "The plan no longer needs it." });
      }
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

export function actionWords(state: SeasonState, a: SwitchAction): string {
  const n = svcName(state, a.serviceId);
  switch (a.kind) {
    case "turn_off": return `${n} goes off ${when(state.today, a.date)} instead of renewing for ${spokenMoney(a.amountCents)}`;
    case "keep": return `${n} renews ${when(state.today, a.date)} for ${spokenMoney(a.amountCents)}`;
    case "turn_on": return `${n} comes on ${when(state.today, a.date)} for ${spokenMoney(a.amountCents)}`;
    case "cancel_start": return `${n} no longer starts ${when(state.today, a.date)}`;
  }
}

function actionShort(state: SeasonState, a: SwitchAction): string {
  const n = svcName(state, a.serviceId);
  return { turn_off: `${n} off ${shortDate(a.date)}`, keep: `${n} renews ${shortDate(a.date)}`, turn_on: `${n} on ${shortDate(a.date)}`, cancel_start: `${n} start cancelled` }[a.kind];
}

// ---------- the household view and the morning briefing ----------

export function refreshDue(state: SeasonState) {
  for (const r of state.reminders) if (r.status === "scheduled" && r.dueDate <= state.today) r.status = "due";
}

function serviceStatus(state: SeasonState, s: SPService): string {
  const paid = s.paidThrough && s.paidThrough > state.today ? s.paidThrough : null;
  if (s.required) return `always on, renews ${shortDate(paid ?? state.today)}`;
  if (paid) return s.autoRenew ? `on, renews ${shortDate(paid)}` : `on until ${shortDate(paid)}, then off`;
  return s.scheduledStart ? `off, starts ${shortDate(s.scheduledStart)}` : "off";
}

export async function getHousehold(state: SeasonState, opts: { briefing?: boolean } = {}) {
  refreshDue(state);
  const plan = await ensurePlan(state);
  const view = {
    household: state.householdName,
    today: state.today,
    dataNotice: state.dataNotice,
    limit: state.maxConcurrent,
    members: state.members.map((m) => ({ id: m.id, name: m.name, aliases: m.aliases, role: m.role, age: m.age, canApproveCharges: m.billingAuthority, watchesWithinDays: m.watchWithinDays })),
    services: state.services.map((s) => ({ id: s.id, name: s.name, tags: s.tags, price: screenMoney(s.priceCents), status: serviceStatus(state, s), paidThrough: s.paidThrough, autoRenew: s.autoRenew, scheduledStart: s.scheduledStart, required: s.required })),
    shows: state.titles.filter((t) => t.kind !== "request").map((t) => {
      const next = t.episodes.find((e) => e.release >= state.today);
      return { id: t.id, name: t.name, service: svcName(state, t.serviceId), followers: t.followers.map((m) => memName(state, m)), nextEpisode: next ? { n: next.n, release: next.release } : null, kind: t.kind };
    }),
    requests: state.titles.filter((t) => t.kind === "request").map((t) => ({ service: svcName(state, t.serviceId), for: t.followers.map((m) => memName(state, m)), startBy: t.availableUntil })),
    plan: planSummary(state, plan),
    preferences: state.preferences.slice(-10),
    pendingConfirmation: state.proposals.find((p) => p.status === "pending" && p.expiresAtMs > 0) ?? null,
    reminders: state.reminders.filter((r) => r.status !== "done"),
    ledger: state.ledger.slice(-12),
  };
  if (!opts.briefing) {
    const speech = `${state.householdName} has ${state.services.filter((s) => s.paidThrough && s.paidThrough > state.today).length} services on today. The plan ${horizonWords(plan)} costs ${spokenMoney(plan.costCents)}.`;
    return { ...view, calendar: calendar(state, plan), briefing: null, speech: cleanSpeech(speech), card: planCard(state, plan, state.householdName) as Card };
  }

  // Proactive moment: speak up only when a billing day or a switch is close, or a reminder is due.
  const due = state.reminders.filter((r) => r.status === "due");
  for (const r of due) r.status = "done";
  const soon = nextActions(state, plan, PROPOSAL_WINDOW_DAYS).filter((x) => !x.alreadySet);
  const urgent = soon.filter((x) => toDay(x.date) - toDay(state.today) <= BRIEFING_NOTICE_DAYS);
  const parts: string[] = [];
  for (const r of due) parts.push(`You asked me to remind you: ${r.note}`);
  const mentions = { titleIds: [] as string[], unfollowedTitleIds: [] as string[], serviceIds: [] as string[] };
  if (urgent.length) {
    const first = urgent[0];
    const s = state.services.find((x) => x.id === first.serviceId)!;
    mentions.serviceIds.push(s.id);
    if (first.kind === "turn_off") {
      parts.push(`Good morning. ${s.name} renews ${when(state.today, first.date)} for ${spokenMoney(s.priceCents)}. The plan lets it go: ${first.why.split(". It comes back")[0].replace(/\.$/, "")}`);
      for (const t of lastNeeded(state, s.id, first.date)) mentions.titleIds.push(t.id);
      for (const t of unfollowedAfter(state, s.id, first.date)) { mentions.titleIds.push(t.id); mentions.unfollowedTitleIds.push(t.id); }
    } else {
      parts.push(`Good morning. ${actionWords(state, first)}. ${first.why}`);
    }
    for (const x of soon.slice(1, 3)) { parts.push(actionWords(state, x)); mentions.serviceIds.push(x.serviceId); }
    parts.push(`That keeps the plan ${horizonWords(plan)} at ${spokenMoney(plan.costCents)}${plan.missed ? "" : ", every followed episode in time"}. Should I set it up?`);
  } else {
    parts.push(soon[0] ? `${due.length ? "" : "Nothing to decide today. "}Next up: ${actionWords(state, soon[0])}.` : due.length ? "" : "Nothing to decide this week. The plan is on track.");
  }
  const speech = cleanSpeech(parts.join(". ").replace(/\.\./g, "."));
  const card: Card = urgent.length
    ? {
      kind: "briefing",
      title: `${actionShort(state, urgent[0])}${soon[1] ? `, ${actionShort(state, soon[1])}` : ""}`,
      fields: [
        { label: urgent[0].kind === "turn_off" ? "Not renewing saves" : "Charged", value: screenMoney(urgent[0].amountCents) },
        { label: `Plan ${horizonWords(plan)}`, value: `${screenMoney(plan.costCents)}, ${coverageText(plan)} episodes in time` },
      ],
      action: { label: "Set it up", utterance: "Okay, set it up." },
      tone: "neutral",
      footnote: `Billing day ${when(state.today, urgent[0].date)}. Nothing changes until ${approvers(state)} says yes.`,
    }
    : { kind: "briefing", title: due.length ? "Reminder" : "Nothing to decide today", fields: [{ label: "Plan", value: screenMoney(plan.costCents) }, { label: "Next", value: soon[0] ? actionShort(state, soon[0]) : "Nothing soon" }], tone: "neutral" };
  return { ...view, calendar: calendar(state, plan), briefing: { dueReminders: due, decisions: soon, urgent: urgent.length > 0, mentions }, speech, card };
}

// ---------- voice-sourced preferences ----------

export interface PreferenceInput {
  kind: PreferenceKind;
  member?: string;
  title?: string;
  service?: string;
  startBy?: string;
  days?: number;
  limit?: number | null;
  utterance?: string;
  source?: "voice" | "screen";
}

function changedServices(state: SeasonState, before: PlanSnapshot | null, after: PlanSnapshot) {
  const out: { serviceId: string; name: string; before: string[]; after: string[] }[] = [];
  for (const s of state.services.filter((x) => !x.required)) {
    const b = (before?.periods ?? []).filter((p) => p.serviceId === s.id).map((p) => p.start);
    const a = after.periods.filter((p) => p.serviceId === s.id).map((p) => p.start);
    if (b.join() !== a.join()) out.push({ serviceId: s.id, name: s.name, before: b, after: a });
  }
  return out;
}

/** Plan periods of one service merged into on-ranges, as words. */
function onRanges(state: SeasonState, plan: PlanSnapshot, serviceId: string): string {
  const svc = state.services.find((s) => s.id === serviceId)!;
  const ranges: [string, string][] = [];
  for (const p of plan.periods.filter((x) => x.serviceId === serviceId)) {
    const end = addMonths(p.start, 1);
    const last = ranges[ranges.length - 1];
    if (last && last[1] === p.start) last[1] = end; else ranges.push([p.start, end]);
  }
  const paid = svc.paidThrough && svc.paidThrough > state.today ? svc.paidThrough : null;
  if (!ranges.length) return paid ? `${svc.name} goes off ${when(state.today, paid)} and stays off` : `${svc.name} stays off`;
  const md = (d: string) => spokenDate(d).split(", ")[1];
  const first = ranges[0];
  if (paid && first[0] === paid) return `${svc.name} stays on until ${md(first[1])}`;
  const lead = paid ? `${svc.name} goes off ${when(state.today, paid)}, then comes back ${md(first[0])} to ${md(first[1])}` : `${svc.name} comes on ${md(first[0])} to ${md(first[1])}`;
  return ranges.length > 1 ? `${lead}, and again ${md(ranges[1][0])}` : lead;
}

export async function recordPreference(state: SeasonState, ctx: CallContext, input: PreferenceInput) {
  const speaker = getMember(state, ctx.speakerId);
  if (!speaker) throw new RuleError("unknown_speaker", "I need to know who is speaking before I change the plan.");
  const target = input.member ? getMember(state, input.member) : speaker;
  if (!target) throw new RuleError("unknown_member", `I don't know ${input.member}. The household is ${listWords(state.members.map((m) => m.name))}.`);
  if (target.id !== speaker.id && speaker.role !== "adult") throw new RuleError("not_allowed_for_others", `${speaker.name} can change only their own shows. An adult can speak for ${target.name}.`);

  const pref: Preference = { id: nextId(state, "p"), date: state.today, turn: ctx.turn, speakerId: speaker.id, forMemberId: target.id, kind: input.kind, text: "", source: input.source ?? "voice" };
  let lead = "";
  switch (input.kind) {
    case "follow_title": {
      if (!input.title) throw new RuleError("missing_title", "Which show?");
      const t = getTitle(state, input.title);
      pref.titleId = t.id;
      const already = t.followers.includes(target.id);
      if (!already) t.followers.push(target.id);
      pref.text = `${target.name} is watching ${t.name}`;
      lead = already ? `${target.name} already follows ${t.name}.` : `Got it, ${target.name} is still watching ${t.name}.`;
      break;
    }
    case "drop_title": {
      if (!input.title) throw new RuleError("missing_title", "Which show?");
      const t = getTitle(state, input.title);
      pref.titleId = t.id;
      t.followers = t.followers.filter((m) => m !== target.id);
      pref.text = `${target.name} stopped watching ${t.name}`;
      lead = `Okay, ${target.name} is done with ${t.name}.`;
      break;
    }
    case "want_service": {
      if (!input.service) throw new RuleError("missing_service", "Which service?");
      const s = getService(state, input.service);
      if (s.required) { lead = `${s.name} is always on already.`; pref.serviceId = s.id; pref.text = `${target.name} asked for ${s.name}`; break; }
      const startBy = input.startBy ?? addDays(state.today, 3);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startBy) || startBy < state.today) throw new RuleError("bad_date", "The start-by date has to be today or later, as YYYY-MM-DD.");
      if (startBy > state.horizonEnd) throw new RuleError("too_far", `The plan only runs until ${spokenDate(state.horizonEnd)}.`);
      pref.serviceId = s.id; pref.startBy = startBy;
      const id = `req-${target.id}-${s.id}`;
      state.titles = state.titles.filter((t) => t.id !== id);
      state.titles.push({ id, name: `${target.name}'s request for ${s.name}`, serviceId: s.id, kind: "request", followers: [target.id], episodes: [{ n: 1, release: state.today }], availableUntil: startBy });
      pref.text = `${target.name} wants ${s.name}, starting by ${shortDate(startBy)}`;
      lead = `Okay, ${s.name} for ${target.name}.`;
      break;
    }
    case "set_pace": {
      const d = input.days;
      if (!d || d < 1 || d > 60) throw new RuleError("bad_days", "Say how many days, between 1 and 60.");
      target.watchWithinDays = Math.round(d);
      pref.days = target.watchWithinDays;
      pref.text = `${target.name} can wait up to ${pref.days} days for new episodes`;
      lead = `Got it, ${target.name} can wait up to ${pref.days} days.`;
      break;
    }
    case "set_limit": {
      if (!speaker.billingAuthority) throw new RuleError("not_authorized", `${speaker.name} can't change the household limit. ${approvers(state)} can.`);
      const l = input.limit;
      if (l !== null && (l === undefined || l < 1 || l > 6)) throw new RuleError("bad_limit", "The limit is between 1 and 6 services at a time, or no limit.");
      state.maxConcurrent = l;
      pref.limit = l;
      pref.text = l === null ? "No limit on services at a time" : `At most ${l} services at a time`;
      lead = l === null ? "Okay, no limit on services at a time." : `Okay, at most ${l} at a time.`;
      break;
    }
    default:
      throw new RuleError("unknown_kind", "Preferences are follow_title, drop_title, want_service, set_pace or set_limit.");
  }
  if (input.utterance) pref.text += ` ("${input.utterance.slice(0, 120)}")`;
  state.preferences.push(pref);
  if (state.preferences.length > 100) state.preferences.splice(0, state.preferences.length - 100);
  state.inputsVersion += 1;
  for (const p of state.proposals) if (p.status === "pending") p.status = "superseded";

  const { before, after } = await replan(state, pref.text);
  const prevCal = before && before.computedOn === after.computedOn ? calendarFor(state, before) : null;
  const focus = pref.serviceId ?? state.titles.find((t) => t.id === pref.titleId)?.serviceId;
  const changes = changedServices(state, before, after).sort((a, b) => Number(b.serviceId === focus) - Number(a.serviceId === focus));
  const delta = before ? after.costCents - before.costCents : 0;
  const parts = [lead];
  if (!changes.length) parts.push("The plan stays the same");
  else {
    parts.push(onRanges(state, after, changes[0].serviceId));
    if (changes.length > 1) parts.push(`${changes.length === 2 ? `${changes[1].name} shifts to make room` : `${changes.length - 1} other services shift to make room`}`);
  }
  if (before) parts.push(delta > 0 ? `That adds ${spokenMoney(delta)} ${horizonWords(after)}` : delta < 0 ? `That saves ${spokenMoney(-delta)} ${horizonWords(after)}` : "Same cost");
  parts.push(after.missed ? `${after.missed} followed episodes don't fit under the limit of ${state.maxConcurrent} at a time` : "Every followed episode is still in time");
  const speech = cleanSpeech(parts.join(". ").replace(/\.\./g, ".") + ".");
  const title = changes.length ? `Re-planned: ${changes.map((c) => c.name).join(", ")}` : "Plan unchanged";
  return {
    preference: pref,
    replan: { solverMs: after.solverMs, costBeforeCents: before?.costCents ?? null, costAfterCents: after.costCents, deltaCents: delta, missedBefore: before?.missed ?? null, missedAfter: after.missed, changes },
    plan: planSummary(state, after),
    calendar: calendar(state, after),
    previousCalendar: prevCal,
    nextActions: nextActions(state, after, PROPOSAL_WINDOW_DAYS).filter((a) => !a.alreadySet),
    card: planCard(state, after, title, delta),
    speech,
  };
}

/** Calendar for an older plan snapshot, drawn against today's paid access, for the before/after animation. */
function calendarFor(state: SeasonState, plan: PlanSnapshot) {
  return calendar(state, plan);
}

export async function explainPlan(state: SeasonState, service?: string) {
  const plan = await ensurePlan(state);
  if (service) {
    const s = getService(state, service);
    const e = explainService(state, plan, s.id);
    return { ...e, card: { kind: "explain", title: `Why ${s.name} is on when it is`, fields: [
      { label: "On", value: e.periods.filter((p) => p.kind !== "required").map((p) => `${shortDate(p.from)} to ${shortDate(p.to)}`).join(", ") || (s.required ? "Every month" : "Not in this plan") },
      { label: "For", value: e.periods.filter((p) => p.kind !== "required")[0]?.forWhat ?? (s.required ? "Always on" : "Nothing followed") },
    ], tone: "neutral" } as Card, speech: e.speech };
  }
  const per = state.services.filter((s) => !s.required).map((s) => explainService(state, plan, s.id));
  const speech = cleanSpeech(`The plan pays for a service only in the months someone needs it, and never more than ${state.maxConcurrent ?? "any number of"} at a time. ${per.filter((p) => p.periods.length).slice(0, 2).map((p) => p.speech).join(" ")}`);
  return { services: per, plan: planSummary(state, plan), card: { kind: "explain", title: "How the plan was chosen", fields: [
    { label: "Rule", value: `Nothing followed is missed, then lowest cost${state.maxConcurrent ? `, max ${state.maxConcurrent} at a time` : ""}` },
    { label: "Checked", value: `${plan.pairs} episode and viewer pairs` },
  ], tone: "neutral" } as Card, speech };
}

// ---------- switches: propose (step 1 of 2) ----------

function stateKey(state: SeasonState): string {
  return JSON.stringify([state.inputsVersion, state.today, state.services.map((s) => [s.id, s.paidThrough, s.autoRenew, s.scheduledStart])]);
}

export async function proposeSwitch(state: SeasonState, ctx: CallContext, opts: { service?: string; withinDays?: number } = {}) {
  const plan = await ensurePlan(state);
  const within = Math.min(Math.max(opts.withinDays ?? PROPOSAL_WINDOW_DAYS, 1), 31);
  let actions = nextActions(state, plan, within);
  if (opts.service) { const s = getService(state, opts.service); actions = actions.filter((a) => a.serviceId === s.id); }
  const todo = actions.filter((a) => !a.alreadySet);
  if (!todo.length) {
    return { confirmationId: null, actions, card: { kind: "receipt", title: "Already set up", fields: [{ label: "Next", value: actions[0] ? actionShort(state, actions[0]) : "Nothing in the next days" }, { label: "Plan", value: screenMoney(plan.costCents) }], tone: "good" } as Card, speech: cleanSpeech(`Everything for the next ${within} days is already set up${actions[0] ? `: ${actionWords(state, actions[0])}` : ""}.`) };
  }
  const charge = todo.filter((a) => a.kind === "turn_on" || a.kind === "keep").reduce((x, a) => x + a.amountCents, 0);
  const avoided = todo.filter((a) => a.kind === "turn_off").reduce((x, a) => x + a.amountCents, 0);
  for (const p of state.proposals) if (p.status === "pending") p.status = "superseded";
  const proposal: Proposal = {
    id: nextId(state, "cf"), planVersion: plan.version, stateKey: stateKey(state), actions: todo, chargeCents: charge, avoidedCents: avoided,
    summary: todo.map((a) => actionShort(state, a)).join(", "),
    speech: cleanSpeech(`To confirm: ${listWords(todo.map((a) => actionWords(state, a)))}. Nothing is charged today. ${approvers(state)}, say yes to confirm.`),
    createdTurn: ctx.turn, createdAtMs: ctx.nowMs, expiresAtMs: ctx.nowMs + CONFIRMATION_TTL_MS, proposedBy: ctx.speakerId, status: "pending",
  };
  state.proposals.push(proposal);
  if (state.proposals.length > 40) state.proposals.splice(0, state.proposals.length - 40);
  const card: Card = {
    kind: "confirm",
    title: proposal.summary + "?",
    fields: [
      { label: "Will be charged", value: charge ? todo.filter((a) => a.kind !== "turn_off" && a.amountCents).map((a) => `${screenMoney(a.amountCents)} on ${shortDate(a.date)}`).join(", ") : "Nothing" },
      { label: "Not charged", value: avoided ? todo.filter((a) => a.kind === "turn_off").map((a) => `${screenMoney(a.amountCents)} on ${shortDate(a.date)}`).join(", ") : "Nothing" },
    ],
    action: { label: "Confirm", utterance: "Yes, confirm.", tool: { name: "confirm_switch", arguments: { confirmation_id: proposal.id } } },
    tone: "neutral",
    footnote: `Needs ${approvers(state)} to say yes. Expires in 10 minutes.`,
  };
  return { confirmationId: proposal.id, actions: todo, chargeCents: charge, avoidedCents: avoided, needsApprovalFrom: state.members.filter((m) => m.billingAuthority).map((m) => m.name), card, speech: proposal.speech };
}

// ---------- switches: confirm (step 2 of 2) ----------

function snapshot(state: SeasonState, ids: string[]): ServiceSnapshot[] {
  return state.services.filter((s) => ids.includes(s.id)).map((s) => ({ serviceId: s.id, autoRenew: s.autoRenew, scheduledStart: s.scheduledStart }));
}

export function confirmSwitch(state: SeasonState, ctx: CallContext, confirmationId: string) {
  const p = state.proposals.find((x) => x.id === confirmationId);
  if (!p) throw new RuleError("unknown_confirmation", "That confirmation does not exist. Ask me to set the switch up again.");
  if (p.status === "confirmed") {
    const done = state.ledger.find((l) => l.id === p.id)!;
    return { alreadyConfirmed: true, change: done, card: receiptCard(state, done), speech: "That switch is already set up. Nothing was done twice." };
  }
  if (p.status === "superseded") throw new RuleError("superseded", "The plan changed after that summary. Ask me to set it up again so you hear the new one.");
  if (p.status === "expired") throw new RuleError("expired", "That confirmation expired. Ask me to set it up again.");
  if (ctx.nowMs > p.expiresAtMs) { p.status = "expired"; throw new RuleError("expired", "That confirmation expired after 10 minutes. Ask me to set it up again."); }
  const speaker = getMember(state, ctx.speakerId);
  if (!speaker) throw new RuleError("unknown_speaker", `I could not tell who said yes. ${approvers(state)} needs to confirm.`);
  if (!speaker.billingAuthority) {
    const who = speaker.role === "teen" ? `${speaker.name} is ${speaker.age}` : speaker.role === "child" ? `${speaker.name} is ${speaker.age}` : `${speaker.name} isn't on the billing account`;
    throw new RuleError("not_authorized", `${who}, so that yes can't approve charges. ${approvers(state)} needs to say yes.`);
  }
  if (ctx.turn <= p.createdTurn) throw new RuleError("needs_new_turn", "A person has to say yes after hearing the summary, in a new turn. I can't confirm on my own.");
  if (p.planVersion !== state.inputsVersion || p.stateKey !== stateKey(state)) {
    p.status = "expired";
    throw new RuleError("stale", "The plan changed since that summary. Ask me to set it up again.");
  }
  const ids = [...new Set(p.actions.map((a) => a.serviceId))];
  const before = snapshot(state, ids);
  for (const a of p.actions) {
    const s = state.services.find((x) => x.id === a.serviceId)!;
    if (a.kind === "turn_off") s.autoRenew = false;
    if (a.kind === "keep") s.autoRenew = true;
    if (a.kind === "turn_on") { s.scheduledStart = a.date; s.autoRenew = true; }
    if (a.kind === "cancel_start") s.scheduledStart = null;
  }
  p.status = "confirmed";
  const first = p.actions.map((a) => a.date).sort()[0];
  const entry: LedgerEntry = {
    id: p.id, date: state.today, atMs: ctx.nowMs, kind: "switch", by: speaker.id, serviceIds: ids, actions: p.actions, amountCents: 0,
    detail: p.summary, undoBefore: first, before,
  };
  state.ledger.push(entry);
  for (const r of state.reminders) if (r.status === "due") r.status = "done";
  const speech = cleanSpeech(`Done, ${speaker.name}. ${listWords(p.actions.map((a) => actionWords(state, a)))}. You can undo it until ${when(state.today, first)}.`);
  return { alreadyConfirmed: false, change: entry, card: receiptCard(state, entry), speech };
}

function receiptCard(state: SeasonState, e: LedgerEntry): Card {
  const charge = (e.actions ?? []).filter((a) => a.kind === "turn_on" || a.kind === "keep").reduce((x, a) => x + a.amountCents, 0);
  const avoided = (e.actions ?? []).filter((a) => a.kind === "turn_off").reduce((x, a) => x + a.amountCents, 0);
  const canUndo = !e.undone && !!e.undoBefore && state.today < e.undoBefore;
  return {
    kind: "receipt",
    title: e.undone ? `Undone: ${e.detail}` : `Set: ${e.detail}`,
    fields: [
      { label: "Charges ahead", value: charge ? screenMoney(charge) : "None" },
      { label: "Charges avoided", value: avoided ? screenMoney(avoided) : "None" },
    ],
    action: canUndo ? { label: "Undo", utterance: "Undo that.", tool: { name: "undo_switch", arguments: { change: e.id } } } : undefined,
    tone: "good",
    footnote: `Confirmed by ${memName(state, e.by)}. Change ${e.id}${canUndo ? `, undo until ${shortDate(e.undoBefore!)}` : ""}.`,
  };
}

// ---------- undo ----------

export function undoSwitch(state: SeasonState, ctx: CallContext, change?: string) {
  const speaker = getMember(state, ctx.speakerId);
  if (!speaker) throw new RuleError("unknown_speaker", `I could not tell who asked. ${approvers(state)} can undo a switch.`);
  if (!speaker.billingAuthority) throw new RuleError("not_authorized", `${speaker.name} can't change billing. ${approvers(state)} can undo it.`);
  const switches = state.ledger.filter((l) => l.kind === "switch" && !l.undone);
  const entry = change ? switches.find((l) => l.id === change) : switches[switches.length - 1];
  if (!entry) throw new RuleError("nothing_to_undo", "There is no switch to undo.");
  if (switches[switches.length - 1] !== entry) throw new RuleError("undo_latest_first", "A later switch changed the same plan. Undo that one first.");
  if (!entry.undoBefore || state.today >= entry.undoBefore) throw new RuleError("already_effective", "That switch already took effect, so it can't be undone now. I can plan a new one.");
  for (const b of entry.before ?? []) {
    const s = state.services.find((x) => x.id === b.serviceId)!;
    s.autoRenew = b.autoRenew;
    s.scheduledStart = b.scheduledStart;
  }
  entry.undone = true;
  state.ledger.push({ id: nextId(state, "ch"), date: state.today, atMs: ctx.nowMs, kind: "undo", by: speaker.id, serviceIds: entry.serviceIds, amountCents: 0, detail: `Undid ${entry.detail}` });
  return { undone: entry.id, card: receiptCard(state, entry), speech: cleanSpeech(`Undone. ${listWords(entry.serviceIds.map((id) => svcName(state, id)))} ${entry.serviceIds.length > 1 ? "are" : "is"} back the way ${entry.serviceIds.length > 1 ? "they were" : "it was"}.`) };
}

// ---------- reminders ----------

export async function scheduleReminder(state: SeasonState, ctx: CallContext, opts: { date?: string; beforeService?: string; note: string }) {
  let due = opts.date;
  let serviceId: string | undefined;
  if (opts.beforeService) {
    const s = getService(state, opts.beforeService);
    serviceId = s.id;
    const plan = await ensurePlan(state);
    const paid = s.paidThrough && s.paidThrough > state.today ? s.paidThrough : null;
    const next = [paid, s.scheduledStart, plan.periods.find((p) => p.serviceId === s.id && p.start > state.today)?.start].filter(Boolean).sort()[0] as string | undefined;
    if (!next) throw new RuleError("nothing_scheduled", `${s.name} has no billing day or start coming up in the plan.`);
    due = addDays(next, -1) < state.today ? state.today : addDays(next, -1);
  }
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new RuleError("bad_date", "Give a date as YYYY-MM-DD, or a service to be reminded before.");
  if (due < state.today) throw new RuleError("past_date", "That date has already passed.");
  if (due > state.horizonEnd) throw new RuleError("too_far", `The plan only runs until ${spokenDate(state.horizonEnd)}.`);
  const r: Reminder = { id: nextId(state, "r"), dueDate: due, note: opts.note.slice(0, 200), createdBy: ctx.speakerId ?? "assistant", serviceId, status: "scheduled" };
  state.reminders.push(r);
  const card: Card = { kind: "reminder", title: `Reminder: ${shortDate(due)}`, fields: [{ label: "Morning of", value: spokenDate(due) }, { label: "About", value: r.note }], tone: "good" };
  return { reminder: r, card, speech: cleanSpeech(`Okay. I'll bring it up on the morning of ${spokenDate(due)}.`) };
}

// ---------- the simulated clock (host-only) ----------

/** Moves the demo clock forward one day at a time, applying starts, renewals and lapses exactly once each. */
export async function advanceClock(state: SeasonState, toDate: string, nowMs: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || toDate <= state.today) throw new RuleError("clock_backwards", "The demo clock only moves forward. Reset the demo to start over.");
  if (toDay(toDate) - toDay(state.today) > 120) throw new RuleError("too_far", "Move the clock at most 120 days at a time.");
  if (toDate > state.horizonEnd) throw new RuleError("too_far", `The demo plan ends on ${state.horizonEnd}.`);
  const events: string[] = [];
  for (let d = addDays(state.today, 1); d <= toDate; d = addDays(d, 1)) {
    for (const s of state.services) {
      const charge = (why: string) => {
        state.ledger.push({ id: nextId(state, "ch"), date: d, atMs: nowMs, kind: "charge", by: "system", serviceIds: [s.id], amountCents: -s.priceCents, detail: `${s.name} ${why} (simulated charge)` });
        s.paidThrough = addMonths(d, 1);
        events.push(`${d}: ${s.name} ${why}, ${screenMoney(s.priceCents)}`);
      };
      if (s.scheduledStart === d) { s.scheduledStart = null; s.autoRenew = true; charge("started"); continue; }
      if (s.paidThrough === d) {
        if (s.autoRenew || s.required) charge("renewed");
        else {
          s.paidThrough = null;
          s.autoRenew = true; // turning it back on later is a new start
          state.ledger.push({ id: nextId(state, "ch"), date: d, atMs: nowMs, kind: "lapse", by: "system", serviceIds: [s.id], amountCents: 0, detail: `${s.name} went off as planned` });
          events.push(`${d}: ${s.name} went off as planned`);
        }
      }
    }
  }
  state.today = toDate;
  refreshDue(state);
  for (const p of state.proposals) if (p.status === "pending") p.status = "expired";
  state.inputsVersion += 1;
  await replan(state, `clock moved to ${toDate}`);
  return { today: state.today, events };
}

export type { ActionKind };
