// Seeded generator of fictional households for the evaluation set. DEMO DATA: all names are made up.
import { Household, Member, Service, Title, addDays, toDay } from "./model";

export const PLAN_START = "2026-11-01";
export const PLAN_END = "2027-04-30";

const SERVICE_POOL: Omit<Service, "required" | "paidThrough">[] = [
  { id: "lumen", name: "Lumen", priceCents: 1549 },
  { id: "orbit", name: "Orbit", priceCents: 1099 },
  { id: "kestrel", name: "Kestrel+", priceCents: 1799 },
  { id: "tidewell", name: "Tidewell", priceCents: 899 },
  { id: "marquee", name: "Marquee", priceCents: 1399 },
  { id: "northline", name: "Northline", priceCents: 1199 },
  { id: "pebble", name: "Pebble Kids", priceCents: 799 },
];
const ADULTS = ["Dana", "Marcus", "Priya", "Tom", "Ines", "Kofi", "Mara", "Joel", "Rosa", "Wen"];
const KIDS = ["Leah", "Theo", "Sami", "Nora", "Eli", "Ivy", "Jun", "Ada"];
const ADJ = ["Quiet", "Copper", "Glass", "Northern", "Paper", "Velvet", "Hollow", "Silver", "Distant", "Crooked", "Amber", "Salt"];
const NOUN = ["Orchard", "Meridian", "Lantern", "Ferry", "Harbor", "Archive", "Signal", "Kingdom", "Tide", "Atlas", "Garden", "Circuit"];
const FAMILY = ["Rivera", "Okafor", "Lindqvist", "Brandt", "Moreau", "Tanaka", "Haddad", "Novak", "Castillo", "Byrne"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `hard` makes bigger, tighter households: more people, more shows, a lower limit on simultaneous services. */
export function generateHousehold(seed: number, hard = false): Household {
  const r = rng(seed * 7919 + 17 + (hard ? 100003 : 0));
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const shuffle = <T,>(xs: T[]) => xs.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const span = toDay(PLAN_END) - toDay(PLAN_START);

  const adults = shuffle(ADULTS).slice(0, hard ? 2 : int(1, 2));
  const kids = shuffle(KIDS).slice(0, hard ? int(1, 3) : int(0, 3));
  const members: Member[] = [
    ...adults.map((n) => ({ id: n.toLowerCase(), name: n, watchWithinDays: pick([7, 14, 14, 30]) })),
    ...kids.map((n) => ({ id: n.toLowerCase(), name: n, watchWithinDays: pick([1, 2, 3, 7]) })),
  ];

  const pool = shuffle(SERVICE_POOL.filter((s) => s.id !== "pebble" || kids.length > 0)).slice(0, hard ? 6 : int(4, 6));
  const activeCount = int(2, Math.min(4, pool.length));
  const services: Service[] = pool.map((s, i) => ({
    ...s,
    required: s.id === "pebble" && r() < 0.5,
    paidThrough: i < activeCount ? addDays(PLAN_START, int(1, 29)) : null,
  }));

  const titles: Title[] = [];
  const nTitles = hard ? int(10, 14) : int(4, 9);
  const used = new Set<string>();
  for (let t = 0; t < nTitles; t++) {
    let name = "";
    do { name = `The ${pick(ADJ)} ${pick(NOUN)}`; } while (used.has(name));
    used.add(name);
    const svc = pick(services);
    const kind = r() < 0.55 ? "weekly" : r() < 0.6 ? "drop" : "leaving";
    const followers = shuffle(members).slice(0, int(1, Math.min(3, members.length))).map((m) => m.id);
    const id = `t${t + 1}`;
    if (kind === "weekly") {
      const n = int(6, 12);
      const first = int(0, Math.max(0, span - 7 * n - 20));
      titles.push({ id, name, serviceId: svc.id, kind, followers, episodes: Array.from({ length: n }, (_, k) => ({ n: k + 1, release: addDays(PLAN_START, first + 7 * k) })) });
    } else if (kind === "drop") {
      const day = int(0, span - 35);
      const n = int(6, 10);
      titles.push({ id, name, serviceId: svc.id, kind, followers, episodes: Array.from({ length: n }, (_, k) => ({ n: k + 1, release: addDays(PLAN_START, day) })) });
    } else {
      const from = r() < 0.5 ? 0 : int(0, span - 60);
      const until = Math.min(span - 1, from + int(10, 45));
      titles.push({ id, name: name.replace("The ", "") + " (film)", serviceId: svc.id, kind, followers, episodes: [{ n: 1, release: addDays(PLAN_START, from) }], availableUntil: addDays(PLAN_START, until) });
    }
  }

  return {
    id: `${hard ? "hard" : "hh"}-${String(seed).padStart(2, "0")}`,
    name: `The ${pick(FAMILY)} household`,
    start: PLAN_START,
    end: PLAN_END,
    maxConcurrent: hard ? pick([1, 2, 2]) : pick([2, 2, 3, null]),
    services,
    members,
    titles,
  };
}

export const generateSet = (n: number, offset = 1, hard = false) => Array.from({ length: n }, (_, i) => generateHousehold(i + offset, hard));
