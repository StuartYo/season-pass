// Plays the 8-step demo script in Claude mode: Claude picks the MCP tools through the real /api/agent route handler,
// the tools run against the real MCP server over Streamable HTTP (in process). Checks that the money rules still come
// from code: the teen's yes must be refused by the server, the adult's yes must go through.
// Costs real money (Claude Opus, low effort): about a few cents per turn. Needs AMAZON_ANTHROPIC_API_KEY.
// Run: SEASONPASS_STORE=memory npx tsx eval/claude-demo.ts
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp/server";
import { ClaudeEngine } from "../src/conversation/claudeEngine";
import { DEMO_SCRIPT } from "../src/conversation/script";
import type { ToolRunner, World } from "../src/conversation/types";
import { POST } from "../app/api/agent/route";

if (!process.env.AMAZON_ANTHROPIC_API_KEY) { console.error("AMAZON_ANTHROPIC_API_KEY is not set."); process.exit(1); }
process.env.SEASONPASS_STORE ??= "memory";

(async () => {
  const who = { speaker: "", turn: 0 };
  const client = new Client({ name: "claude-demo-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-seasonpass-household", "claude-demo");
      headers.set("x-seasonpass-speaker", who.speaker);
      headers.set("x-seasonpass-turn", String(who.turn));
      return handleMcpRequest(new Request(url, { ...init, headers }));
    },
  }));
  const tools: ToolRunner = {
    async call(name, args) {
      const r: any = await client.callTool({ name, arguments: args });
      return { name, args, isError: Boolean(r.isError), data: r.structuredContent ?? null, text: r.content?.[0]?.text ?? "" };
    },
  };
  const world = async (): Promise<World> => JSON.parse(((await client.readResource({ uri: "seasonpass://household" })).contents[0] as any).text);
  await tools.call("demo_reset", {});

  let usd = 0, calls = 0;
  const steps: any[] = [];
  const engine = new ClaudeEngine("http://localhost/api/agent", async (url, init) => {
    const t0 = Date.now();
    const res = await POST(new Request(url as string, { ...(init as RequestInit), headers: { ...(init?.headers as any), "x-forwarded-for": "claude-demo" } }));
    const data = await res.clone().json();
    calls++;
    if (typeof data.costUsd === "number") usd += data.costUsd;
    steps.push({ ms: Date.now() - t0, status: res.status, costUsd: data.costUsd, usage: data.usage, error: data.error });
    return res;
  });

  const turns: any[] = [];
  for (const step of DEMO_SCRIPT) {
    who.turn += 1;
    const w = await world();
    const t0 = Date.now();
    const input = step.kind === "event"
      ? (who.speaker = "", { type: "event" as const, event: "morning" as const, today: w.today })
      : (who.speaker = step.speaker, { type: "utterance" as const, speakerId: step.speaker, speakerName: w.members.find((m) => m.id === step.speaker)?.name ?? step.speaker, text: step.text, source: "scripted" as const });
    const out = await engine.handle(input, tools, w);
    const row = {
      speaker: step.kind === "event" ? "(morning event)" : step.speaker, said: step.kind === "say" ? step.text : "",
      tools: out.results.map((r) => `${r.name}${r.isError ? `!${r.data?.error ?? "error"}` : ""}`),
      speech: out.speech, error: out.error, fellBack: out.fellBackToRules ?? false, ms: Date.now() - t0,
    };
    turns.push(row);
    console.log(`${row.speaker}: ${row.said}\n  tools: ${row.tools.join(", ") || "-"}\n  alexa: ${row.speech}${row.error ? `\n  ERROR: ${row.error}` : ""}\n  ${row.ms} ms, spent $${usd.toFixed(3)}`);
  }
  await client.close();

  const flat = turns.flatMap((t) => t.tools as string[]);
  const leah = turns[4].tools as string[], marcus = turns[5].tools as string[];
  const checks = {
    teenYesRefusedByServer: leah.some((t) => t.startsWith("confirm_switch!not_authorized")),
    teenYesNeverConfirmed: !leah.includes("confirm_switch"),
    adultYesConfirmed: marcus.includes("confirm_switch"),
    proposeBeforeConfirm: flat.indexOf("propose_switch") >= 0 && flat.indexOf("propose_switch") < flat.indexOf("confirm_switch"),
    noSymbolsInSpeech: turns.every((t) => !/[$%|*#<>{}[\]]/.test(t.speech ?? "")),
    noErrors: turns.every((t) => !t.error && !t.fellBack),
  };
  const summary = { model: process.env.SEASONPASS_MODEL ?? "claude-opus-5-5", effort: process.env.SEASONPASS_EFFORT ?? "low", apiCalls: calls, apiSpendUsd: Math.round(usd * 10000) / 10000, checks, turns, steps };
  const out = path.join(__dirname, "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `claude-demo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ apiCalls: calls, apiSpendUsd: summary.apiSpendUsd, checks }, null, 2));
})();
