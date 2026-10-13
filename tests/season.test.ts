import { describe, expect, it } from "vitest";
import * as rules from "../src/season/rules";
import { seedHousehold } from "../src/season/seed";
import { CallContext, RuleError, SeasonState } from "../src/season/types";
import { score } from "../src/rotation/model";

const T0 = 1_800_000_000_000;
const ctx = (speakerId: string | null, turn: number, nowMs = T0): CallContext => ({ householdId: "test", speakerId, turn, nowMs });
const fresh = (): SeasonState => seedHousehold("test");
async function code(fn: () => unknown): Promise<string> {
  try { await fn(); } catch (e) { if (e instanceof RuleError) return e.code; throw e; }
  return "no_error";
}
const SYMBOLS = /[$%|*#<>{}[\]]/;

describe("planning", () => {
  it("plans the demo household exactly: no missed episodes, valid under the household limit", async () => {
    const s = fresh();
    const { after } = await rules.replan(s, "test");
    expect(after.solverStatus).toBe("Optimal");
    expect(after.missed).toBe(0);
    expect(score(rules.toHousehold(s), { periods: after.periods }).violations).toEqual([]);
    expect(after.costCents).toBeLessThan(after.keepAllOnCents);
  });

  it("speaks up before Lumen's billing day and names the show nobody follows", async () => {
    const s = fresh();
    const h = await rules.getHousehold(s, { briefing: true });
    expect(h.briefing!.urgent).toBe(true);
    expect(h.briefing!.decisions[0]).toMatchObject({ serviceId: "lumen", kind: "turn_off", date: "2026-11-05" });
    expect(h.briefing!.mentions.unfollowedTitleIds).toEqual(["quiet-orchard"]);
    expect(h.speech).toContain("Quiet Orchard");
    expect(h.speech).not.toMatch(SYMBOLS);
    expect(h.card.fields.length).toBeLessThanOrEqual(2);
  });
});

describe("voice-sourced preferences re-plan immediately", () => {
  it("'I'm still watching that show' brings Lumen back and reports the cost", async () => {
    const s = fresh();
    await rules.replan(s, "start");
    const before = s.plan!.costCents;
    const r = await rules.recordPreference(s, ctx("marcus", 1), { kind: "follow_title", title: "Quiet Orchard" });
    expect(r.preference.forMemberId).toBe("marcus");
    expect(r.replan.changes.map((c) => c.serviceId)).toEqual(["lumen"]);
    expect(r.replan.deltaCents).toBe(1549);
    expect(s.plan!.costCents).toBe(before + 1549);
    expect(s.plan!.missed).toBe(0);
    expect(r.previousCalendar).not.toBeNull();
    expect(r.speech).not.toMatch(SYMBOLS);
    expect(r.replan.solverMs).toBeLessThan(5000);
  });

  it("an adult can ask for a service for grandma; it is on by the start-by date", async () => {
    const s = fresh();
    await rules.replan(s, "start");
    const r = await rules.recordPreference(s, ctx("dana", 1), { kind: "want_service", member: "grandma", service: "cooking channel" });
    expect(r.preference.forMemberId).toBe("rosa");
    const tide = s.plan!.periods.filter((p) => p.serviceId === "tidewell").map((p) => p.start);
    expect(tide[0] <= "2026-11-05").toBe(true);
    expect(s.plan!.missed).toBe(0);
  });

  it("a teen can't speak for someone else, and only billing adults change the limit", async () => {
    const s = fresh();
    expect(await code(() => rules.recordPreference(s, ctx("leah", 1), { kind: "want_service", member: "rosa", service: "tidewell" }))).toBe("not_allowed_for_others");
    expect(await code(() => rules.recordPreference(s, ctx("rosa", 1), { kind: "set_limit", limit: 3 }))).toBe("not_authorized");
    expect(await code(() => rules.recordPreference(s, ctx(null, 1), { kind: "follow_title", title: "Quiet Orchard" }))).toBe("unknown_speaker");
  });

  it("being able to wait longer never makes the plan more expensive", async () => {
    const s = fresh();
    await rules.replan(s, "start");
    const before = s.plan!.costCents;
    await rules.recordPreference(s, ctx("dana", 1), { kind: "set_pace", days: 30 });
    expect(s.plan!.costCents).toBeLessThanOrEqual(before);
  });
});

describe("switches: propose, then an authorized adult confirms", () => {
  async function proposed() {
    const s = fresh();
    const p = await rules.proposeSwitch(s, ctx("dana", 1));
    return { s, p };
  }

  it("computes the amounts in code and changes nothing yet", async () => {
    const { s, p } = await proposed();
    expect(p.confirmationId).toBeTruthy();
    expect(p.actions).toEqual([expect.objectContaining({ serviceId: "lumen", kind: "turn_off", date: "2026-11-05", amountCents: 1549 })]);
    expect(p.avoidedCents).toBe(1549);
    expect(p.chargeCents).toBe(0);
    expect(p.speech).not.toMatch(SYMBOLS);
    expect(s.services.find((x) => x.id === "lumen")!.autoRenew).toBe(true);
  });

  it("refuses a teen's yes, a child's yes, and an unknown voice", async () => {
    const { s, p } = await proposed();
    expect(await code(() => rules.confirmSwitch(s, ctx("leah", 2), p.confirmationId!))).toBe("not_authorized");
    expect(await code(() => rules.confirmSwitch(s, ctx("theo", 2), p.confirmationId!))).toBe("not_authorized");
    expect(await code(() => rules.confirmSwitch(s, ctx("rosa", 2), p.confirmationId!))).toBe("not_authorized");
    expect(await code(() => rules.confirmSwitch(s, ctx(null, 2), p.confirmationId!))).toBe("unknown_speaker");
    expect(s.services.find((x) => x.id === "lumen")!.autoRenew).toBe(true);
  });

  it("refuses a yes in the same turn as the summary (the assistant cannot confirm itself)", async () => {
    const { s, p } = await proposed();
    expect(await code(() => rules.confirmSwitch(s, ctx("dana", 1), p.confirmationId!))).toBe("needs_new_turn");
  });

  it("expires after 10 minutes", async () => {
    const { s, p } = await proposed();
    expect(await code(() => rules.confirmSwitch(s, ctx("dana", 2, T0 + 10 * 60 * 1000 + 1), p.confirmationId!))).toBe("expired");
  });

  it("refuses a summary that a later preference made out of date", async () => {
    const { s, p } = await proposed();
    await rules.recordPreference(s, ctx("marcus", 2), { kind: "follow_title", title: "Quiet Orchard" });
    expect(await code(() => rules.confirmSwitch(s, ctx("marcus", 3), p.confirmationId!))).toBe("superseded");
  });

  it("applies once, is idempotent, and can be undone before the billing day", async () => {
    const { s, p } = await proposed();
    const c = rules.confirmSwitch(s, ctx("marcus", 2), p.confirmationId!);
    expect(c.change.by).toBe("marcus");
    expect(s.services.find((x) => x.id === "lumen")!.autoRenew).toBe(false);
    const again = rules.confirmSwitch(s, ctx("marcus", 3), p.confirmationId!);
    expect(again.alreadyConfirmed).toBe(true);
    expect(s.ledger.filter((l) => l.kind === "switch")).toHaveLength(1);
    expect(await code(() => rules.undoSwitch(s, ctx("leah", 4)))).toBe("not_authorized");
    rules.undoSwitch(s, ctx("dana", 4));
    expect(s.services.find((x) => x.id === "lumen")!.autoRenew).toBe(true);
    expect(await code(() => rules.undoSwitch(s, ctx("dana", 5)))).toBe("nothing_to_undo");
  });

  it("can't undo once the switch took effect", async () => {
    const { s, p } = await proposed();
    rules.confirmSwitch(s, ctx("dana", 2), p.confirmationId!);
    await rules.advanceClock(s, "2026-11-06", T0);
    expect(await code(() => rules.undoSwitch(s, ctx("dana", 3)))).toBe("already_effective");
  });
});

describe("the simulated clock and money", () => {
  it("a confirmed switch-off means no charge; without it the service renews and charges", async () => {
    const a = fresh();
    const p = await rules.proposeSwitch(a, ctx("dana", 1));
    rules.confirmSwitch(a, ctx("dana", 2), p.confirmationId!);
    const ra = await rules.advanceClock(a, "2026-11-06", T0);
    expect(ra.events.join(" ")).toContain("Lumen went off as planned");
    expect(a.ledger.some((l) => l.kind === "charge" && l.serviceIds[0] === "lumen")).toBe(false);
    expect(a.services.find((x) => x.id === "lumen")!.paidThrough).toBeNull();

    const b = fresh();
    await rules.advanceClock(b, "2026-11-06", T0);
    const charge = b.ledger.find((l) => l.kind === "charge" && l.serviceIds[0] === "lumen")!;
    expect(charge.amountCents).toBe(-1549);
    expect(b.services.find((x) => x.id === "lumen")!.paidThrough).toBe("2026-12-05");
  });

  it("a confirmed start charges once on its day; pending proposals expire when the clock moves", async () => {
    const s = fresh();
    await rules.replan(s, "start");
    await rules.recordPreference(s, ctx("dana", 1), { kind: "want_service", member: "rosa", service: "tidewell", startBy: "2026-11-05" });
    const p = await rules.proposeSwitch(s, ctx("dana", 2));
    const on = p.actions.find((a) => a.serviceId === "tidewell" && a.kind === "turn_on")!;
    expect(on.amountCents).toBe(899);
    rules.confirmSwitch(s, ctx("dana", 3), p.confirmationId!);
    const p2 = await rules.proposeSwitch(s, ctx("dana", 4));
    expect(p2.confirmationId).toBeNull(); // already set up
    await rules.advanceClock(s, "2026-11-10", T0);
    const charges = s.ledger.filter((l) => l.kind === "charge" && l.serviceIds[0] === "tidewell");
    expect(charges).toHaveLength(1);
    expect(charges[0].date).toBe(on.date);
  });

  it("reminders fire in the morning briefing on their day", async () => {
    const s = fresh();
    const r = await rules.scheduleReminder(s, ctx("dana", 1), { beforeService: "kestrel", note: "Kestrel+ renews tomorrow" });
    expect(r.reminder.dueDate).toBe("2026-11-19");
    await rules.advanceClock(s, "2026-11-19", T0);
    const h = await rules.getHousehold(s, { briefing: true });
    expect(h.speech).toContain("Kestrel+ renews tomorrow");
    expect(s.reminders[0].status).toBe("done");
  });

  it("explains a service from the plan's own data", async () => {
    const s = fresh();
    const e = await rules.explainPlan(s, "Orbit");
    expect(e.speech).toContain("The Copper Meridian");
    expect(e.speech).not.toMatch(SYMBOLS);
  });
});
