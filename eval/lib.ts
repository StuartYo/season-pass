// Shared by the baseline (which calls the model) and the hard-set preview (which doesn't).
import { Household, Plan, RULES_TEXT, addMonths } from "../src/rotation/model";

export function statusQuo(h: Household): Plan {
  const periods = [];
  for (const s of h.services.filter((x) => !x.required && x.paidThrough)) {
    let d = s.paidThrough!;
    while (d <= h.end) { periods.push({ serviceId: s.id, start: d }); d = addMonths(d, 1); }
  }
  return { periods };
}

export function promptFor(h: Household): string {
  const data = { plan: { start: h.start, end: h.end }, maxConcurrent: h.maxConcurrent, services: h.services, members: h.members, titles: h.titles };
  return `Plan this household's streaming subscriptions so everyone can watch what they follow in time, at the lowest cost.

${RULES_TEXT}

Household data (JSON):
${JSON.stringify(data)}

Think it through carefully, then answer with only a JSON object in this exact shape, listing every period to pay for (do not list required services):
{"periods": [{"serviceId": "lumen", "start": "2026-11-05"}]}`;
}

export function parsePlan(text: string): Plan | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j.periods)) return null;
    return { periods: j.periods.map((p: any) => ({ serviceId: String(p.serviceId ?? p.service ?? ""), start: String(p.start ?? "") })) };
  } catch {
    return null;
  }
}

