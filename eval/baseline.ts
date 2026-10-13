// Day-1 stop-loss: is the planner worth building, or does a plain model already do this?
// 50 fictional households. Each gets: the exact optimizer, a "keep what you have" status quo,
// and a pure model (same Claude model, same data, same rules text, no tools). Every plan is scored by the same code.
//
// Run (PowerShell, key from the user environment, never printed):
//   $env:ANTHROPIC_API_KEY=[Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User'); npx tsx eval/baseline.ts
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { generateSet } from "../src/rotation/generate";
import { optimize } from "../src/rotation/optimize";
import { Household, Plan, RULES_TEXT, addMonths, score, windows } from "../src/rotation/model";

const N = Number(process.env.EVAL_N ?? 50);
const HARD = process.env.EVAL_HARD === "1";
const TAG = HARD ? "hard-" : "";
const MODEL = process.env.EVAL_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.EVAL_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh";
const BUDGET_USD = Number(process.env.EVAL_BUDGET_USD ?? 8);
const CONCURRENCY = 5;
const OUT = path.join(__dirname, "out");
const RAW = path.join(OUT, `raw-${TAG}${MODEL}-${EFFORT}`);
mkdirSync(RAW, { recursive: true });

const PRICE: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] };
let spent = 0;

function statusQuo(h: Household): Plan {
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

function parsePlan(text: string): Plan | null {
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

const client = new Anthropic();

async function pureModel(h: Household) {
  const file = path.join(RAW, `${h.id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (spent >= BUDGET_USD) return { skipped: true };
  const t0 = Date.now();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: EFFORT },
    messages: [{ role: "user", content: promptFor(h) }],
  });
  const msg = await stream.finalMessage();
  const text = msg.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
  const p = PRICE[MODEL] ?? PRICE["claude-opus-5-5"];
  const cost = (msg.usage.input_tokens * p[0] + msg.usage.output_tokens * p[1]) / 1e6;
  spent += cost;
  const rec = { household: h.id, model: msg.model, effort: EFFORT, stop: msg.stop_reason, ms: Date.now() - t0, usage: msg.usage, costUsd: cost, text };
  writeFileSync(file, JSON.stringify(rec, null, 2));
  return rec;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

(async () => {
  const set = generateSet(N, 1, HARD);
  writeFileSync(path.join(OUT, `${TAG}households.json`), JSON.stringify(set, null, 1));
  const rows = await pool(set, CONCURRENCY, async (h) => {
    const opt = await optimize(h);
    const so = score(h, opt.plan);
    const sq = score(h, statusQuo(h));
    let model: any = { skipped: true };
    try {
      const r = await pureModel(h);
      if (!r.skipped) {
        const plan = parsePlan(r.text);
        model = plan ? { ...score(h, plan), parsed: true, costUsd: r.costUsd, outputTokens: r.usage.output_tokens } : { parsed: false, costUsd: r.costUsd };
      }
    } catch (e: any) {
      model = { error: String(e?.message ?? e).slice(0, 200) };
    }
    const row = {
      id: h.id, services: h.services.length, titles: h.titles.length, members: h.members.length, cap: h.maxConcurrent, pairs: windows(h).length,
      optStatus: opt.status, optMs: opt.ms, opt: { cost: so.costCents, missed: so.missed, violations: so.violations.length },
      statusQuo: { cost: sq.costCents, missed: sq.missed, violations: sq.violations.length },
      model: model.parsed ? { cost: model.costCents, missed: model.missed, violations: model.violations.length, rules: model.violations.map((v: any) => v.rule), apiUsd: model.costUsd } : model,
    };
    console.log(`${h.id} opt $${(so.costCents / 100).toFixed(2)} miss ${so.missed} | model ${model.parsed ? `$${(model.costCents / 100).toFixed(2)} miss ${model.missed} viol ${model.violations.length}` : JSON.stringify(model).slice(0, 80)} | spent $${spent.toFixed(2)}`);
    return row;
  });
  writeFileSync(path.join(OUT, `${TAG}results-${MODEL}-${EFFORT}.json`), JSON.stringify(rows, null, 1));

  const scored = rows.filter((r: any) => r.model && typeof r.model.cost === "number");
  const parsedFail = rows.filter((r: any) => r.model && r.model.parsed === false).length;
  const near = (r: any) => r.model.violations === 0 && r.model.missed <= r.opt.missed && r.model.cost <= r.opt.cost * 1.05;
  const sum = (f: (r: any) => number, xs = scored) => xs.reduce((a, r) => a + f(r), 0);
  const summary = {
    model: MODEL, effort: EFFORT, households: rows.length, modelScored: scored.length, modelUnparseable: parsedFail,
    modelNearOptimal: scored.filter(near).length,
    modelWithViolations: scored.filter((r: any) => r.model.violations > 0).length,
    modelMissedMoreThanOptimal: scored.filter((r: any) => r.model.missed > r.opt.missed).length,
    modelCostOver5pct: scored.filter((r: any) => r.model.cost > r.opt.cost * 1.05).length,
    totals: {
      optimalCostUsd: sum((r) => r.opt.cost) / 100, modelCostUsd: sum((r) => r.model.cost) / 100, statusQuoCostUsd: sum((r) => r.statusQuo.cost, rows) / 100,
      optimalMissed: sum((r) => r.opt.missed), modelMissed: sum((r) => r.model.missed), statusQuoMissed: sum((r) => r.statusQuo.missed, rows),
      modelViolations: sum((r) => r.model.violations), optimalViolations: sum((r) => r.opt.violations, rows),
    },
    apiSpendUsd: Math.round(spent * 100) / 100,
  };
  writeFileSync(path.join(OUT, `${TAG}summary-${MODEL}-${EFFORT}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})();
