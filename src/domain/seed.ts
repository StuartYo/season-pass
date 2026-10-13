// DEMO DATA. Every name, brand, price and viewing record below is fictional.
// Usage stands in for what a household's Fire TV and Echo devices could report (simulated).
import { HouseholdState } from "./types";

export const DEMO_TODAY = "2026-10-20";
export const DATA_NOTICE =
  "Demo data. The family, the streaming brands, the prices and the watch history are fictional and simulated.";

export function seedHousehold(householdId: string): HouseholdState {
  return {
    householdId,
    householdName: "The Rivera household",
    today: DEMO_TODAY,
    dataNotice: DATA_NOTICE,
    seq: 1,
    members: [
      { id: "dana", name: "Dana", role: "adult", age: 44, billingAuthority: true },
      { id: "marcus", name: "Marcus", role: "adult", age: 46, billingAuthority: true },
      { id: "leah", name: "Leah", role: "teen", age: 15, billingAuthority: false },
      { id: "theo", name: "Theo", role: "child", age: 9, billingAuthority: false },
    ],
    subscriptions: [
      {
        id: "streamvale",
        name: "StreamVale",
        category: "video",
        usageSource: "Living room Fire TV watch history (simulated)",
        planId: "premium",
        plans: [
          { id: "premium", name: "Premium", priceCents: 1799, period: "month", note: "4K, no ads" },
          { id: "standard", name: "Standard", priceCents: 1199, period: "month", note: "HD, no ads" },
          { id: "basic_ads", name: "Basic with ads", priceCents: 699, period: "month", note: "HD, with ads" },
        ],
        policy: { cancelEffective: "end_of_period", pauseMonths: [], refundWindowDays: 0, refundMaxSessionsSinceCharge: 0 },
        status: "active",
        nextRenewal: "2026-10-23",
        lastCharge: { date: "2026-09-23", amountCents: 1799 },
        sessionsSinceLastCharge: 19,
        usage: [
          { memberId: "leah", hours30d: 16.5, sessions30d: 17, hours60d: 29, lastUsed: "2026-10-19", topTitle: "Harbor Lights, season 2" },
          { memberId: "dana", hours30d: 1, sessions30d: 1, hours60d: 3.5, lastUsed: "2026-10-04", topTitle: "a cooking show" },
          { memberId: "marcus", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: "2026-07-30" },
          { memberId: "theo", hours30d: 0, sessions30d: 0, hours60d: 0.5, lastUsed: "2026-08-28" },
        ],
        events: [{ id: "harbor-lights-finale", title: "Harbor Lights season 2 finale", date: "2026-10-29", memberId: "leah" }],
        version: 1,
      },
      {
        id: "kinobox",
        name: "KinoBox",
        category: "video",
        usageSource: "Living room Fire TV watch history (simulated)",
        planId: "standard",
        plans: [{ id: "standard", name: "Standard", priceCents: 1399, period: "month" }],
        policy: { cancelEffective: "end_of_period", pauseMonths: [1, 2, 3], refundWindowDays: 0, refundMaxSessionsSinceCharge: 0 },
        status: "active",
        nextRenewal: "2026-10-22",
        lastCharge: { date: "2026-09-22", amountCents: 1399 },
        sessionsSinceLastCharge: 0,
        usage: [
          { memberId: "marcus", hours30d: 0, sessions30d: 0, hours60d: 2, lastUsed: "2026-09-09", topTitle: "a heist movie" },
          { memberId: "dana", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: "2026-06-11" },
          { memberId: "leah", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: null },
          { memberId: "theo", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: null },
        ],
        events: [],
        version: 1,
      },
      {
        id: "fitloop",
        name: "FitLoop",
        category: "fitness",
        usageSource: "FitLoop app activity shared with the household (simulated)",
        planId: "annual",
        plans: [
          { id: "annual", name: "Annual", priceCents: 11999, period: "year" },
          { id: "monthly", name: "Monthly", priceCents: 1299, period: "month" },
        ],
        policy: { cancelEffective: "end_of_period", pauseMonths: [], refundWindowDays: 14, refundMaxSessionsSinceCharge: 1 },
        status: "active",
        nextRenewal: "2027-10-17",
        lastCharge: { date: "2026-10-17", amountCents: 11999 },
        sessionsSinceLastCharge: 0,
        usage: [
          { memberId: "marcus", hours30d: 0, sessions30d: 0, hours60d: 0.5, lastUsed: "2026-08-25", topTitle: "a 30 minute ride" },
          { memberId: "dana", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: "2026-03-02" },
          { memberId: "leah", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: null },
          { memberId: "theo", hours30d: 0, sessions30d: 0, hours60d: 0, lastUsed: null },
        ],
        events: [],
        version: 1,
      },
      {
        id: "tunewave",
        name: "TuneWave Family",
        category: "music",
        usageSource: "Echo listening history (simulated)",
        planId: "family",
        plans: [
          { id: "family", name: "Family", priceCents: 1999, period: "month", maxMembers: 6 },
          { id: "duo", name: "Duo", priceCents: 1499, period: "month", maxMembers: 2 },
        ],
        policy: { cancelEffective: "end_of_period", pauseMonths: [1], refundWindowDays: 0, refundMaxSessionsSinceCharge: 0 },
        status: "active",
        nextRenewal: "2026-10-29",
        lastCharge: { date: "2026-09-29", amountCents: 1999 },
        sessionsSinceLastCharge: 140,
        usage: [
          { memberId: "leah", hours30d: 31, sessions30d: 52, hours60d: 60, lastUsed: "2026-10-20" },
          { memberId: "dana", hours30d: 22, sessions30d: 40, hours60d: 41, lastUsed: "2026-10-20" },
          { memberId: "marcus", hours30d: 15, sessions30d: 28, hours60d: 33, lastUsed: "2026-10-19" },
          { memberId: "theo", hours30d: 9, sessions30d: 20, hours60d: 17, lastUsed: "2026-10-18" },
        ],
        events: [],
        version: 1,
      },
    ],
    votes: {},
    memory: [
      {
        id: "m1",
        date: "2026-09-14",
        subscriptionId: "streamvale",
        memberId: "dana",
        kind: "decision",
        text: "We keep StreamVale only while Leah is still watching Harbor Lights.",
      },
      {
        id: "m2",
        date: "2026-09-30",
        subscriptionId: "fitloop",
        memberId: "marcus",
        kind: "note",
        text: "Marcus said he would start riding again in October.",
      },
    ],
    reminders: [],
    proposals: [],
    ledger: [],
  };
}
