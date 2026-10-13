// The rules conversation engine, end to end against the real MCP handler (no AI involved).
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp/server";
import { parseIntent, parseDate } from "../src/conversation/intents";
import { RulesEngine } from "../src/conversation/rulesEngine";
import { ClaudeEngine } from "../src/conversation/claudeEngine";
import { DEMO_SCRIPT } from "../src/conversation/script";
import type { ToolRunner, World } from "../src/conversation/types";

async function host(household: string) {
  const who = { speaker: "", turn: 0 };
  const client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-seasonpass-household", household);
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
  return { who, client, tools, world };
}

describe("intent parser", () => {
  const world: World = {
    today: "2026-11-02",
    members: [
      { id: "dana", name: "Dana", role: "adult", age: 42, canApproveCharges: true, aliases: ["mom"] },
      { id: "rosa", name: "Rosa", role: "adult", age: 71, canApproveCharges: false, aliases: ["grandma"] },
      { id: "leah", name: "Leah", role: "teen", age: 15, canApproveCharges: false },
    ],
    services: [
      { id: "lumen", name: "Lumen", required: false, scheduledStart: null, paidThrough: "2026-11-05", tags: ["drama"] },
      { id: "tidewell", name: "Tidewell", required: false, scheduledStart: null, paidThrough: null, tags: ["cooking", "cooking channel"] },
      { id: "kestrel", name: "Kestrel+", required: false, scheduledStart: null, paidThrough: null, tags: ["movies"] },
    ],
    shows: [
      { id: "harbor-lights", name: "Harbor Lights", service: "Lumen", followers: ["Leah"] },
      { id: "quiet-orchard", name: "Quiet Orchard", service: "Lumen", followers: [] },
    ],
  };
  const ctx = { recentTitleIds: ["harbor-lights", "quiet-orchard"], recentServiceIds: ["lumen"], speakerId: "dana" };

  it("resolves 'that show' to the show just mentioned that the speaker doesn't follow", () => {
    expect(parseIntent("Hold on, I'm still watching that show.", world, ctx)).toEqual({ type: "follow", title: "quiet-orchard", member: undefined });
  });
  it("maps 'the cooking channel' and 'grandma' to the service and the member", () => {
    expect(parseIntent("Grandma wants the cooking channel this month.", world, ctx)).toEqual({ type: "want", service: "tidewell", member: "rosa", startBy: undefined });
  });
  it("tells set-up, yes, no, undo, remind and why apart", () => {
    expect(parseIntent("Okay, set it up.", world, ctx).type).toBe("propose");
    expect(parseIntent("Yes! Do it.", world, ctx).type).toBe("confirm");
    expect(parseIntent("No, not now.", world, ctx).type).toBe("decline");
    expect(parseIntent("Undo that.", world, ctx).type).toBe("undo");
    expect(parseIntent("Remind us the day before Lumen renews.", world, ctx)).toMatchObject({ type: "remind", service: "lumen" });
    expect(parseIntent("Why is Kestrel+ off?", world, ctx)).toEqual({ type: "explain", service: "kestrel" });
    expect(parseIntent("I'm done with Harbor Lights", world, ctx)).toMatchObject({ type: "drop", title: "harbor-lights" });
    expect(parseIntent("I can wait a couple of weeks", world, ctx)).toMatchObject({ type: "pace", days: 14 });
    expect(parseIntent("Only two services at a time", world, ctx)).toEqual({ type: "limit", limit: 2 });
    expect(parseIntent("Tell me a joke", world, ctx).type).toBe("unknown");
  });
  it("reads dates relative to the household's today", () => {
    expect(parseDate("tomorrow", "2026-11-02")).toBe("2026-11-03");
    expect(parseDate("on friday", "2026-11-02")).toBe("2026-11-06");
    expect(parseDate("january 15", "2026-11-02")).toBe("2027-01-15");
  });
});

describe("rules engine plays the demo script against the MCP server", () => {
  it("runs every scripted turn; the teen's yes is refused by the server, the adult's goes through", async () => {
    const h = await host("conv-demo");
    await h.tools.call("demo_reset", {});
    const engine = new RulesEngine();
    const out = [];
    for (const step of DEMO_SCRIPT) {
      h.who.turn += 1;
      const world = await h.world();
      if (step.kind === "event") {
        h.who.speaker = "";
        out.push(await engine.handle({ type: "event", event: "morning", today: world.today }, h.tools, world));
      } else {
        h.who.speaker = step.speaker;
        out.push(await engine.handle({ type: "utterance", speakerId: step.speaker, speakerName: step.speaker, text: step.text, source: "scripted" }, h.tools, world));
      }
    }
    const names = out.map((o) => o.results.map((r) => r.name).join("+"));
    expect(names).toEqual(["get_household", "record_preference", "record_preference", "propose_switch", "confirm_switch", "confirm_switch", "schedule_reminder", "explain_plan"]);
    expect(out[1].results[0].data.preference.titleId).toBe("quiet-orchard");
    expect(out[2].results[0].data.preference.forMemberId).toBe("rosa");
    expect(out[4].results[0].isError).toBe(true);
    expect(out[4].results[0].data.error).toBe("not_authorized");
    expect(out[5].results[0].isError).toBe(false);
    for (const o of out) expect(o.speech).not.toMatch(/[$%|*#<>{}[\]]/);
    await h.client.close();
  }, 60_000);
});

describe("Claude mode falls back to rules mode when the demo's AI caps are reached", () => {
  it("answers the turn with the rules engine, through the same MCP tools, and stays in rules mode", async () => {
    const h = await host("conv-capped");
    await h.tools.call("demo_reset", {});
    let posts = 0;
    const capped = async () => { posts++; return new Response(JSON.stringify({ error: "The demo's AI budget for today is used up.", budget: true }), { status: 429 }); };
    const engine = new ClaudeEngine("/api/agent", capped as any);
    h.who.turn = 1;
    const world = await h.world();
    const first = await engine.handle({ type: "event", event: "morning", today: world.today }, h.tools, world);
    expect(first.fellBackToRules).toBe(true);
    expect(first.notice).toMatch(/budget/);
    expect(first.results.map((r) => r.name)).toEqual(["get_household"]);
    h.who.turn = 2; h.who.speaker = "marcus";
    const second = await engine.handle({ type: "utterance", speakerId: "marcus", speakerName: "Marcus", text: "Hold on, I'm still watching that show.", source: "scripted" }, h.tools, await h.world());
    expect(second.fellBackToRules).toBe(true);
    expect(posts).toBe(1);
    await h.client.close();
  }, 30_000);
});

describe("public demo caps", () => {
  it("blocks on the monthly, daily and per-visitor limits", async () => {
    const { capReason, DAILY_CAP_USD, MONTHLY_CAP_USD } = await import("../src/agent/agent");
    const base = { day: "2026-10-14", usd: 0, steps: {}, visitorUsd: {}, month: "2026-10", monthUsd: 0 };
    expect(capReason(base, "a")).toBeNull();
    expect(capReason({ ...base, monthUsd: MONTHLY_CAP_USD }, "a")).toMatch(/month/);
    expect(capReason({ ...base, usd: DAILY_CAP_USD }, "a")).toMatch(/today/);
    expect(capReason({ ...base, visitorUsd: { a: 10 } }, "a")).toMatch(/this browser/);
    expect(capReason({ ...base, steps: { a: 1000 } }, "b")).toBeNull();
  });
});
