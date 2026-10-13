// Claude mode: one reasoning step of the simulated Alexa+ assistant. The browser (the MCP host) runs the tool calls.
import { aiConfigured, API_KEY_ENV, BudgetError, budgetStatus, DAILY_CAP_USD, MODEL, step } from "@/agent/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function visitorOf(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim().slice(0, 64);
}

export async function GET() {
  const b = await budgetStatus();
  return Response.json({ model: MODEL, keyEnv: API_KEY_ENV, configured: aiConfigured(), capUsd: DAILY_CAP_USD, spentTodayUsd: b.usd, aiAvailable: aiConfigured() && b.usd < DAILY_CAP_USD });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  try {
    return Response.json(await step(body?.messages, visitorOf(req)));
  } catch (e: any) {
    if (e instanceof BudgetError) return Response.json({ error: e.message, budget: true }, { status: 429 });
    const status = typeof e?.status === "number" ? 502 : 400;
    console.error("[season-pass] agent error", e?.message);
    return Response.json({ error: status === 502 ? "The assistant service had a problem. Try again." : String(e?.message ?? e).slice(0, 200) }, { status });
  }
}
