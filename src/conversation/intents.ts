// Deterministic intent parser for the "rules" conversation mode. No AI: keyword patterns plus the household's own
// names for shows, services and people. It is deliberately narrow; anything it doesn't understand gets a help reply.
import type { World } from "./types";

export type Intent =
  | { type: "follow"; title?: string; member?: string }
  | { type: "drop"; title?: string; member?: string }
  | { type: "want"; service: string; member?: string; startBy?: string }
  | { type: "pace"; days: number; member?: string }
  | { type: "limit"; limit: number | null }
  | { type: "plan" }
  | { type: "explain"; service?: string }
  | { type: "propose"; service?: string }
  | { type: "confirm" }
  | { type: "decline" }
  | { type: "undo" }
  | { type: "remind"; service?: string; date?: string; note: string }
  | { type: "household" }
  | { type: "unknown" };

export interface ParseContext {
  /** Shows the assistant just talked about; "that show" means the first one the speaker does not follow yet. */
  recentTitleIds: string[];
  recentServiceIds: string[];
  speakerId: string;
}

const NUM: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const clean = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' +]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => clean(s).replace(/\bthe\b/g, "").replace(/\s+/g, " ").trim();

function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "tomorrow", "friday", "december 3", "this weekend", "this week", "this month", "today" -> ISO date. */
export function parseDate(text: string, today: string): string | undefined {
  const t = clean(text);
  if (/\btoday\b|right now|\bnow\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  if (/this weekend/.test(t)) return addDays(today, ((6 - dow + 7) % 7) || 7);
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd >= 0) return addDays(today, ((wd - dow + 7) % 7) || 7);
  const m = t.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})`));
  if (m) {
    const month = MONTHS.indexOf(m[1]);
    let year = Number(today.slice(0, 4));
    const candidate = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (candidate(year) < today) year += 1;
    return candidate(year);
  }
  return undefined;
}

function findTitle(text: string, world: World): string | undefined {
  const t = words(text);
  const exact = world.shows.find((s) => t.includes(words(s.name)));
  if (exact) return exact.id;
  // One distinctive word is enough ("orchard", "meridian").
  return world.shows.find((s) => words(s.name).split(" ").some((w) => w.length >= 5 && new RegExp(`\\b${w}\\b`).test(t)))?.id;
}

function findService(text: string, world: World): string | undefined {
  const t = clean(text);
  const byName = world.services.find((s) => new RegExp(`\\b${clean(s.name).replace(/\+/g, "\\+?")}`).test(t));
  if (byName) return byName.id;
  for (const s of world.services) for (const tag of s.tags ?? []) if (t.includes(clean(tag))) return s.id;
  return undefined;
}

/** Someone else named in the sentence ("grandma wants ..."). Aliases come from the world. */
function findOtherMember(text: string, world: World, speakerId: string): string | undefined {
  const t = clean(text);
  for (const m of world.members) {
    if (m.id === speakerId) continue;
    const names = [m.name, ...(m.aliases ?? [])].map(clean);
    if (names.some((n) => new RegExp(`\\b${n}\\b`).test(t))) return m.id;
  }
  return undefined;
}

function parseDays(t: string): number {
  const m = t.match(/(\d+)\s*(day|week|month)s?/);
  if (m) return Number(m[1]) * (m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1);
  const w = t.match(/\b(a|an|one|two|couple|three|four)\b(?: of)?\s+(day|week|month)s?/);
  if (w) return NUM[w[1]] * (w[2] === "week" ? 7 : w[2] === "month" ? 30 : 1);
  return 14;
}

export function parseIntent(text: string, world: World, ctx: ParseContext): Intent {
  const t = clean(text);
  if (!t) return { type: "unknown" };
  const title = findTitle(text, world);
  const service = findService(text, world);
  const other = findOtherMember(text, world, ctx.speakerId);
  const thatShow = () => {
    if (title) return title;
    if (/\b(that|this|the) (show|series|one)\b|\bit\b/.test(t)) {
      const recent = ctx.recentTitleIds.map((id) => world.shows.find((s) => s.id === id)).filter(Boolean) as World["shows"];
      const me = world.members.find((m) => m.id === ctx.speakerId)?.name;
      // Prefer a show nobody follows (the briefing just said so), then one the speaker doesn't follow yet.
      return (recent.find((s) => s.followers.length === 0) ?? recent.find((s) => !s.followers.includes(me ?? "")) ?? recent[0])?.id;
    }
    return undefined;
  };

  if (/\bundo\b|take (that|it) back|\breverse (that|it)\b|change (that|it) back/.test(t)) return { type: "undo" };
  if (/\bremind\b/.test(t)) {
    const svc = service ?? (/\b(starts?|renews?|billing|comes on)\b/.test(t) ? ctx.recentServiceIds[0] : undefined);
    return { type: "remind", service: svc, date: svc ? undefined : parseDate(text, world.today) ?? addDays(world.today, 1), note: text.trim().replace(/^remind (us|me)( to)?\s*/i, "").slice(0, 180) || "Check the streaming plan" };
  }
  if (/\b(done with|gave up|give up|giving up|stopped watching|stop watching|not watching|quit watching|finished with|over it)\b/.test(t)) {
    return { type: "drop", title: thatShow(), member: other };
  }
  if (/\b(still|keep|been|am|i'm|im|i am|are) (watching|following)\b|\bcatch(ing)? up on\b|\bhaven't finished\b|\bstill on\b|\bwant to (watch|see|finish)\b/.test(t) && !(service && !title && !/that show|this show/.test(t))) {
    return { type: "follow", title: thatShow(), member: other };
  }
  if (service && /\b(want|wants|wanted|like|need|needs|get|turn on|switch on|add|bring back|could we|can we|can i)\b/.test(t) && !/\bwhy\b/.test(t)) {
    const startBy = /this month|this week|soon|\bnow\b|today/.test(t) && !/today|\bnow\b/.test(t) ? undefined : parseDate(text, world.today);
    return { type: "want", service, member: other, startBy };
  }
  if (/\b(can|could|don't mind|dont mind|happy to|fine to|ok to|okay to|able to) wait\b|\bno rush\b|\bwatch (it|them|episodes) later\b/.test(t)) {
    return { type: "pace", days: parseDays(t), member: other };
  }
  if (/\bno limit\b/.test(t)) return { type: "limit", limit: null };
  const lim = t.match(/\b(at most|only|max|maximum|no more than)\s+(one|two|three|four|five|six|\d)\s+(services?|at a time|at once)/);
  if (lim) return { type: "limit", limit: NUM[lim[2]] ?? Number(lim[2]) };
  if (/\bwhy\b|\bexplain\b|how come|what('s| is) .* for\b/.test(t)) return { type: "explain", service };
  if (/\b(set (it|that|this|them) up|make the switch|do the switch|go with (it|that|the plan)|let's do (it|that)|switch (it|them) over|follow the plan)\b/.test(t)) return { type: "propose", service };
  if (/^(yes|yeah|yep|yup|sure|confirm|confirmed|go ahead|approved?|do it|ok|okay|sounds good)\b/.test(t)) return { type: "confirm" };
  if (/^(no|nope|not now|hold off|cancel that|never ?mind|don't)\b/.test(t)) return { type: "decline" };
  if (/\b(plan|rotation|schedule|how much|cost|costs|what's coming|what is coming)\b/.test(t)) return { type: "plan" };
  if (/\b(who|what do we (pay|have)|services|household)\b/.test(t)) return { type: "household" };
  return { type: "unknown" };
}
