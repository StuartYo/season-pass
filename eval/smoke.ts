import { generateSet } from "../src/rotation/generate";
import { optimize } from "../src/rotation/optimize";
import { score, Household, Plan } from "../src/rotation/model";

function statusQuo(h: Household): Plan {
  // Keep every currently paid service renewing; add nothing.
  const { addMonths } = require("../src/rotation/model");
  const periods = [];
  for (const s of h.services.filter((x) => !x.required && x.paidThrough)) {
    let d = s.paidThrough!; while (d <= h.end) { periods.push({ serviceId: s.id, start: d }); d = addMonths(d, 1); }
  }
  return { periods };
}
(async () => {
  for (const h of generateSet(5)) {
    const o = await optimize(h);
    const so = score(h, o.plan), sq = score(h, statusQuo(h));
    console.log(h.id, h.services.length, "svc", h.titles.length, "titles cap", h.maxConcurrent, "|", o.status, o.ms + "ms", "vars", o.variables, "| opt $", so.costCents / 100, "missed", so.missed, "viol", so.violations.length, "| statusQuo $", sq.costCents / 100, "missed", sq.missed, "viol", sq.violations.length);
  }
})();
