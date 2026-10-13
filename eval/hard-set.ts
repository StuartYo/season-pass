// Hard set preview: builds the harder households and solves them with the planner. No API calls.
// Run: npx tsx eval/hard-set.ts            (50 households, same seeds the baseline will use with EVAL_HARD=1)
// Then, once AMAZON_ANTHROPIC_API_KEY exists: EVAL_HARD=1 npx tsx eval/baseline.ts
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { generateSet } from "../src/rotation/generate";
import { optimize } from "../src/rotation/optimize";
import { score, windows } from "../src/rotation/model";
import { promptFor, statusQuo } from "./lib";

const N = Number(process.env.EVAL_N ?? 50);
const OUT = path.join(__dirname, "out");
mkdirSync(OUT, { recursive: true });

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

async function describe(hard: boolean) {
  const set = generateSet(N, 1, hard);
  const rows = [];
  for (const h of set) {
    const o = await optimize(h);
    const sc = score(h, o.plan);
    const sq = score(h, statusQuo(h));
    rows.push({
      id: h.id, members: h.members.length, services: h.services.length, titles: h.titles.length, cap: h.maxConcurrent, pairs: windows(h).length,
      promptChars: promptFor(h).length, status: o.status, ms: o.ms, variables: o.variables, constraints: o.constraints,
      planner: { cost: sc.costCents, missed: sc.missed, violations: sc.violations.length }, statusQuo: { cost: sq.costCents, missed: sq.missed, violations: sq.violations.length },
    });
  }
  return { set, rows };
}

(async () => {
  const normal = await describe(false);
  const hard = await describe(true);
  writeFileSync(path.join(OUT, "hard-households.json"), JSON.stringify(hard.set, null, 1));
  writeFileSync(path.join(OUT, "hard-planner.json"), JSON.stringify(hard.rows, null, 1));
  const line = (name: string, r: typeof hard.rows) => ({
    set: name,
    households: r.length,
    membersAvg: +avg(r.map((x) => x.members)).toFixed(1),
    showsAvg: +avg(r.map((x) => x.titles)).toFixed(1),
    limit: [...new Set(r.map((x) => x.cap ?? "none"))].join("/"),
    pairsAvg: Math.round(avg(r.map((x) => x.pairs))),
    promptCharsAvg: Math.round(avg(r.map((x) => x.promptChars))),
    plannerMedianMs: median(r.map((x) => x.ms)),
    plannerMaxMs: Math.max(...r.map((x) => x.ms)),
    plannerOptimal: r.filter((x) => x.status === "Optimal").length,
    plannerViolations: r.reduce((a, x) => a + x.planner.violations, 0),
    plannerMissedAvg: +avg(r.map((x) => x.planner.missed)).toFixed(1),
    statusQuoMissedAvg: +avg(r.map((x) => x.statusQuo.missed)).toFixed(1),
    statusQuoOverLimit: r.filter((x) => x.statusQuo.violations > 0).length,
  });
  const summary = [line("normal (already run against the model)", normal.rows), line("hard (ready, not run against the model yet)", hard.rows)];
  writeFileSync(path.join(OUT, "hard-summary.json"), JSON.stringify(summary, null, 2));
  console.table(summary);
})();
