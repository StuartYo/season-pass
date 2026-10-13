// The demo household. DEMO DATA: every service, show and person here is fictional.
import type { Title } from "../rotation/model";
import { addDays } from "../rotation/model";
import type { SeasonState } from "./types";

export const DEMO_TODAY = "2026-11-02"; // a Monday
export const DEMO_HORIZON_END = "2027-04-30";
export const DATA_NOTICE = "Demo data. Every service, show and family member is fictional.";

function weekly(id: string, name: string, serviceId: string, first: string, n: number, followers: string[]): Title {
  return { id, name, serviceId, kind: "weekly", followers, episodes: Array.from({ length: n }, (_, k) => ({ n: k + 1, release: addDays(first, 7 * k) })) };
}

function drop(id: string, name: string, serviceId: string, day: string, n: number, followers: string[]): Title {
  return { id, name, serviceId, kind: "drop", followers, episodes: Array.from({ length: n }, (_, k) => ({ n: k + 1, release: day })) };
}

export function seedHousehold(householdId: string): SeasonState {
  return {
    householdId,
    householdName: "The Rivera household",
    today: DEMO_TODAY,
    horizonEnd: DEMO_HORIZON_END,
    maxConcurrent: 2,
    members: [
      { id: "dana", name: "Dana", aliases: ["mom", "mum"], role: "adult", age: 42, billingAuthority: true, watchWithinDays: 14 },
      { id: "marcus", name: "Marcus", aliases: ["dad"], role: "adult", age: 44, billingAuthority: true, watchWithinDays: 30 },
      { id: "rosa", name: "Rosa", aliases: ["grandma", "grandmother", "abuela", "nana"], role: "adult", age: 71, billingAuthority: false, watchWithinDays: 7 },
      { id: "leah", name: "Leah", aliases: [], role: "teen", age: 15, billingAuthority: false, watchWithinDays: 2 },
      { id: "theo", name: "Theo", aliases: [], role: "child", age: 8, billingAuthority: false, watchWithinDays: 3 },
    ],
    services: [
      { id: "lumen", name: "Lumen", priceCents: 1549, required: false, tags: ["drama"], paidThrough: "2026-11-05", autoRenew: true, scheduledStart: null },
      { id: "orbit", name: "Orbit", priceCents: 1099, required: false, tags: ["sci-fi", "science fiction"], paidThrough: null, autoRenew: true, scheduledStart: null },
      { id: "kestrel", name: "Kestrel+", priceCents: 1799, required: false, tags: ["movies", "films"], paidThrough: "2026-11-20", autoRenew: true, scheduledStart: null },
      { id: "tidewell", name: "Tidewell", priceCents: 899, required: false, tags: ["cooking", "cooking channel", "food", "kitchen", "recipes"], paidThrough: null, autoRenew: true, scheduledStart: null },
      { id: "pebble", name: "Pebble Kids", priceCents: 799, required: true, tags: ["kids", "cartoons"], paidThrough: "2026-11-14", autoRenew: true, scheduledStart: null },
    ],
    titles: [
      weekly("harbor-lights", "Harbor Lights", "lumen", "2026-09-02", 10, ["leah"]), // finale Wednesday 2026-11-04
      weekly("quiet-orchard", "Quiet Orchard", "lumen", "2026-10-01", 10, []), // Marcus stopped in October, or so the plan assumes
      weekly("copper-meridian", "The Copper Meridian", "orbit", "2026-11-12", 8, ["dana", "marcus"]),
      drop("glass-kingdom", "Glass Kingdom", "orbit", "2027-02-10", 8, ["leah"]),
      { id: "velvet-archive", name: "Velvet Archive", serviceId: "kestrel", kind: "leaving", followers: ["dana"], episodes: [{ n: 1, release: "2026-10-01" }], availableUntil: "2026-11-28" },
      drop("northern-signal", "Northern Signal", "kestrel", "2027-01-15", 6, ["dana", "leah"]),
      weekly("salt-ember", "Salt and Ember Kitchen", "tidewell", "2027-03-04", 6, ["rosa"]),
      weekly("little-comets", "Little Comets", "pebble", "2026-09-07", 30, ["theo"]),
    ],
    preferences: [],
    inputsVersion: 1,
    plan: null,
    proposals: [],
    ledger: [],
    reminders: [],
    dataNotice: DATA_NOTICE,
    seq: 0,
  };
}
