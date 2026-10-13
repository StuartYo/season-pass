import { describe, expect, it } from "vitest";
import { Household, Plan, addDays, score } from "../src/rotation/model";
import { optimize } from "../src/rotation/optimize";
import { generateSet } from "../src/rotation/generate";

function tiny(seed: number): Household {
  let a = seed;
  const r = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  const start = "2027-01-01", end = "2027-01-20";
  const ids = ["lumen", "orbit", "tidewell"];
  const services = ids.map((id, i) => ({ id, name: id, priceCents: [1549, 1099, 899][i], required: false, paidThrough: r() < 0.3 ? addDays(start, 1 + Math.floor(r() * 10)) : null }));
  const members = [{ id: "dana", name: "Dana", watchWithinDays: 3 }, { id: "leah", name: "Leah", watchWithinDays: 1 }];
  const titles = Array.from({ length: 3 + Math.floor(r() * 3) }, (_, k) => ({
    id: `t${k}`, name: `T${k}`, serviceId: ids[Math.floor(r() * 3)], kind: "drop" as const,
    followers: r() < 0.5 ? ["dana"] : ["dana", "leah"],
    episodes: [{ n: 1, release: addDays(start, Math.floor(r() * 19)) }],
  }));
  return { id: `tiny-${seed}`, name: "tiny", start, end, maxConcurrent: r() < 0.5 ? 1 : 2, services, members, titles };
}

/** Every plan with at most one period per service in a 20-day horizon (a period lasts at least 28 days). */
function bruteForce(h: Household) {
  const days = Array.from({ length: 20 }, (_, i) => addDays(h.start, i));
  const options = h.services.map((s) => [null, ...days.filter((d) => !s.paidThrough || d >= s.paidThrough)]);
  let best: { missed: number; cost: number } | null = null;
  const rec = (i: number, periods: Plan["periods"]) => {
    if (i === options.length) {
      const sc = score(h, { periods });
      if (sc.violations.length) return;
      if (!best || sc.missed < best.missed || (sc.missed === best.missed && sc.costCents < best.cost)) best = { missed: sc.missed, cost: sc.costCents };
      return;
    }
    for (const d of options[i]) rec(i + 1, d ? [...periods, { serviceId: h.services[i].id, start: d }] : periods);
  };
  rec(0, []);
  return best!;
}

describe("rotation optimizer", () => {
  it("matches brute force on 25 small households", async () => {
    for (let s = 1; s <= 25; s++) {
      const h = tiny(s);
      const o = await optimize(h);
      const sc = score(h, o.plan);
      const b = bruteForce(h);
      expect(sc.violations, h.id).toEqual([]);
      expect([sc.missed, sc.costCents], h.id).toEqual([b.missed, b.cost]);
    }
  }, 60_000);

  it("returns valid plans for generated households", async () => {
    for (const h of generateSet(8)) {
      const o = await optimize(h);
      expect(o.status).toBe("Optimal");
      expect(score(h, o.plan).violations).toEqual([]);
    }
  }, 60_000);
});

describe("plan scorer", () => {
  const h = generateSet(1)[0];
  it("flags paying twice, unknown services, bad dates and periods outside the plan", () => {
    const paid = h.services.find((s) => s.paidThrough && !s.required)!;
    const sc = score(h, { periods: [
      { serviceId: paid.id, start: h.start },
      { serviceId: "nopeflix", start: h.start },
      { serviceId: paid.id, start: "2026-13-01" },
      { serviceId: paid.id, start: "2027-06-01" },
    ] });
    expect(sc.violations.map((v) => v.rule).sort()).toEqual(["bad_date", "double_paid", "outside_plan", "unknown_service"]);
  });
});
