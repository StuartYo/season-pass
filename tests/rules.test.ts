import { describe, expect, it } from "vitest";
import * as rules from "../src/domain/rules";
import { seedHousehold } from "../src/domain/seed";
import { CallContext, HouseholdState, RuleError } from "../src/domain/types";

const T0 = 1_800_000_000_000;
const ctx = (speakerId: string | null, turn: number, nowMs = T0): CallContext => ({ householdId: "test", speakerId, turn, nowMs });
const fresh = (): HouseholdState => seedHousehold("test");
function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof RuleError) return e.code; throw e; }
  return "no_error";
}
const SYMBOLS = /[$%|*#<>{}[\]]/;

describe("briefing", () => {
  it("lists renewals in the next 7 days, refundable charges, and a code-computed suggestion", () => {
    const s = fresh();
    const b = rules.briefing(s);
    expect(b.renewals.map((r) => r.subscriptionId)).toEqual(["kinobox", "streamvale"]);
    expect(b.renewals[0].suggestion.action).toBe("cancel");
    expect(b.renewals[1].suggestion.action).toBe("downgrade");
    expect(b.refundable.map((r) => r.subscriptionId)).toEqual(["fitloop"]);
    expect(b.refundable[0].refund.amountCents).toBe(11999);
    expect(b.speech).not.toMatch(SYMBOLS);
    expect(b.card.fields.length).toBeLessThanOrEqual(2);
  });
});

describe("two-step confirmation", () => {
  it("computes the amount and date in code", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "KinoBox", action: "cancel" });
    expect(p.proposal.monthlyChangeCents).toBe(-1399);
    expect(p.proposal.effectiveDate).toBe("2026-10-22");
    expect(p.proposal.reversible).toBe(true);
    expect(p.speech).not.toMatch(SYMBOLS);
    expect(s.subscriptions.find((x) => x.id === "kinobox")!.status).toBe("active"); // nothing changed yet
  });

  it("refuses to confirm in the same turn as the proposal (the model cannot self-confirm)", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 3), { subscriptionId: "kinobox", action: "cancel" });
    expect(code(() => rules.confirm(s, ctx("dana", 3), p.confirmationId))).toBe("needs_new_turn");
  });

  it("refuses a yes from someone without billing authority, or from an unknown voice", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    expect(code(() => rules.confirm(s, ctx("leah", 2), p.confirmationId))).toBe("not_authorized");
    expect(code(() => rules.confirm(s, ctx("theo", 2), p.confirmationId))).toBe("not_authorized");
    expect(code(() => rules.confirm(s, ctx(null, 2), p.confirmationId))).toBe("unknown_speaker");
    expect(rules.confirm(s, ctx("marcus", 2), p.confirmationId).change.confirmedBy).toBe("marcus");
  });

  it("expires after 10 minutes", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    expect(code(() => rules.confirm(s, ctx("dana", 2, T0 + 10 * 60 * 1000 + 1), p.confirmationId))).toBe("expired");
  });

  it("never applies a change twice", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    rules.confirm(s, ctx("dana", 2), p.confirmationId);
    const again = rules.confirm(s, ctx("dana", 3), p.confirmationId);
    expect(again.alreadyConfirmed).toBe(true);
    expect(s.ledger.filter((l) => l.subscriptionId === "kinobox")).toHaveLength(1);
  });

  it("rejects an older proposal once a newer one replaced it", () => {
    const s = fresh();
    const a = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    rules.propose(s, ctx("dana", 2), { subscriptionId: "kinobox", action: "pause", pauseMonths: 2 });
    expect(code(() => rules.confirm(s, ctx("dana", 3), a.confirmationId))).toBe("superseded");
  });

  it("detects a stale proposal when the subscription changed underneath it", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    s.subscriptions.find((x) => x.id === "kinobox")!.version += 1;
    expect(code(() => rules.confirm(s, ctx("dana", 2), p.confirmationId))).toBe("stale");
  });
});

describe("provider policies live in code", () => {
  it("only pauses when the provider offers it, for the lengths it offers", () => {
    const s = fresh();
    expect(code(() => rules.propose(s, ctx("dana", 1), { subscriptionId: "streamvale", action: "pause" }))).toBe("pause_not_offered");
    expect(code(() => rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "pause", pauseMonths: 4 }))).toBe("pause_length_not_offered");
    expect(rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "pause", pauseMonths: 3 }).proposal.pauseMonths).toBe(3);
  });

  it("won't downgrade to a plan too small for the people who use it", () => {
    const s = fresh();
    expect(code(() => rules.propose(s, ctx("dana", 1), { subscriptionId: "tunewave", action: "downgrade", toPlanId: "duo" }))).toBe("plan_too_small");
  });

  it("won't call a more expensive plan a downgrade", () => {
    const s = fresh();
    s.subscriptions.find((x) => x.id === "streamvale")!.planId = "basic_ads";
    expect(code(() => rules.propose(s, ctx("dana", 1), { subscriptionId: "streamvale", action: "downgrade", toPlanId: "premium" }))).toBe("not_cheaper");
  });

  it("refunds exactly the charge on file, inside the window and usage limit only", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("marcus", 1), { subscriptionId: "fitloop", action: "refund_and_cancel" });
    expect(p.proposal.refundCents).toBe(11999);
    expect(p.proposal.reversible).toBe(false);
    const done = rules.confirm(s, ctx("marcus", 2), p.confirmationId);
    expect(done.change.amountCents).toBe(11999);
    expect(code(() => rules.undo(s, ctx("marcus", 3), p.confirmationId))).toBe("not_reversible");
    expect(code(() => rules.propose(s, ctx("marcus", 4), { subscriptionId: "fitloop", action: "refund_and_cancel" }))).toBe("not_active");

    const used = fresh();
    used.subscriptions.find((x) => x.id === "fitloop")!.sessionsSinceLastCharge = 2;
    expect(code(() => rules.propose(used, ctx("marcus", 1), { subscriptionId: "fitloop", action: "refund_and_cancel" }))).toBe("refund_not_eligible");

    const late = fresh();
    rules.advanceClock(late, "2026-11-01", T0);
    expect(code(() => rules.propose(late, ctx("marcus", 1), { subscriptionId: "fitloop", action: "refund_and_cancel" }))).toBe("refund_not_eligible");
  });

  it("re-checks refund eligibility at confirmation time", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("marcus", 1), { subscriptionId: "fitloop", action: "refund_and_cancel" });
    s.subscriptions.find((x) => x.id === "fitloop")!.sessionsSinceLastCharge = 5; // someone used it meanwhile
    expect(code(() => rules.confirm(s, ctx("marcus", 2), p.confirmationId))).toBe("refund_not_eligible");
  });

  it("refuses refunds where the provider has no refund policy", () => {
    const s = fresh();
    expect(code(() => rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "refund_and_cancel" }))).toBe("refund_not_eligible");
  });
});

describe("undo", () => {
  it("restores a scheduled change before it takes effect, and only an adult can undo", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "streamvale", action: "downgrade", toPlanId: "basic_ads" });
    rules.confirm(s, ctx("dana", 2), p.confirmationId);
    expect(code(() => rules.undo(s, ctx("leah", 3), "streamvale"))).toBe("not_authorized");
    rules.undo(s, ctx("dana", 3), "streamvale");
    const sub = s.subscriptions.find((x) => x.id === "streamvale")!;
    expect(sub.scheduled).toBeUndefined();
    expect(sub.planId).toBe("premium");
  });

  it("can't undo after the change took effect", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    rules.confirm(s, ctx("dana", 2), p.confirmationId);
    rules.advanceClock(s, "2026-10-23", T0);
    expect(s.subscriptions.find((x) => x.id === "kinobox")!.status).toBe("canceled");
    expect(code(() => rules.undo(s, ctx("dana", 3), p.confirmationId))).toBe("already_effective");
  });
});

describe("household decisions", () => {
  it("needs an adult before anything is suggested", () => {
    const s = fresh();
    const r = rules.recordVote(s, ctx("leah", 1), "streamvale", "keep", "finale is next week");
    expect(r.resolution.status).toBe("needs_adult");
    expect(r.resolution.recommended).toBeNull();
  });

  it("offers a compromise when a parent wants to cancel what a teen uses a lot, tied to her finale", () => {
    const s = fresh();
    rules.recordVote(s, ctx("leah", 1), "streamvale", "keep", "finale is next week");
    const r = rules.recordVote(s, ctx("dana", 2), "streamvale", "cancel", "too expensive");
    expect(r.resolution.status).toBe("compromise");
    expect(r.resolution.recommended).toBe("downgrade");
    expect(r.resolution.toPlanId).toBe("basic_ads");
    expect(r.resolution.reminder).toMatchObject({ eventId: "harbor-lights-finale", dueDate: "2026-10-30" });
    expect(r.card.fields.length).toBeLessThanOrEqual(2);
  });

  it("waits when the adults disagree", () => {
    const s = fresh();
    rules.recordVote(s, ctx("dana", 1), "kinobox", "cancel", "nobody watches");
    const r = rules.recordVote(s, ctx("marcus", 2), "kinobox", "keep", "I might watch something");
    expect(r.resolution.status).toBe("adults_disagree");
  });

  it("records a vote only for the person the device recognised", () => {
    const s = fresh();
    expect(code(() => rules.recordVote(s, ctx(null, 1), "kinobox", "cancel", "x"))).toBe("unknown_speaker");
    rules.recordVote(s, ctx("marcus", 1), "kinobox", "cancel", "fine");
    expect(s.votes.kinobox.map((v) => v.memberId)).toEqual(["marcus"]);
  });
});

describe("clock, renewals and reminders", () => {
  it("charges each renewal exactly once and applies scheduled changes at the renewal date", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "streamvale", action: "downgrade", toPlanId: "basic_ads" });
    rules.confirm(s, ctx("dana", 2), p.confirmationId);
    rules.advanceClock(s, "2026-10-25", T0);
    rules.advanceClock(s, "2026-10-25", T0);
    const sv = s.subscriptions.find((x) => x.id === "streamvale")!;
    expect(sv.planId).toBe("basic_ads");
    expect(sv.nextRenewal).toBe("2026-11-23");
    const charges = s.ledger.filter((l) => l.kind === "renewal_charge" && l.subscriptionId === "streamvale");
    expect(charges).toHaveLength(1);
    expect(charges[0].amountCents).toBe(-699);
  });

  it("pauses at the renewal date and resumes billing after the pause", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "pause", pauseMonths: 1 });
    rules.confirm(s, ctx("dana", 2), p.confirmationId);
    rules.advanceClock(s, "2026-10-30", T0);
    const kb = s.subscriptions.find((x) => x.id === "kinobox")!;
    expect(kb.status).toBe("paused");
    expect(s.ledger.some((l) => l.kind === "renewal_charge" && l.subscriptionId === "kinobox")).toBe(false);
    rules.advanceClock(s, "2026-11-23", T0);
    expect(kb.status === "active" || s.subscriptions.find((x) => x.id === "kinobox")!.status === "active").toBe(true);
  });

  it("fires an event reminder the day after the finale and shows it in the briefing", () => {
    const s = fresh();
    rules.scheduleReminder(s, ctx("dana", 1), "streamvale", { eventId: "harbor-lights-finale", note: "Decide on StreamVale after the finale." });
    expect(rules.briefing(s).dueReminders).toHaveLength(0);
    rules.advanceClock(s, "2026-10-30", T0);
    const b = rules.briefing(s);
    expect(b.dueReminders).toHaveLength(1);
    expect(b.speech).toContain("StreamVale");
  });

  it("warns when a reminder would land after the renewal", () => {
    const s = fresh();
    const r = rules.scheduleReminder(s, ctx("dana", 1), "streamvale", { eventId: "harbor-lights-finale", note: "Decide later." });
    expect(r.warning).toBeTruthy();
  });

  it("never moves backwards", () => {
    const s = fresh();
    expect(code(() => rules.advanceClock(s, "2026-10-01", T0))).toBe("clock_backwards");
  });

  it("expires pending confirmations when the day changes", () => {
    const s = fresh();
    const p = rules.propose(s, ctx("dana", 1), { subscriptionId: "kinobox", action: "cancel" });
    rules.advanceClock(s, "2026-10-21", T0);
    expect(code(() => rules.confirm(s, ctx("dana", 2), p.confirmationId))).toBe("expired");
  });
});
