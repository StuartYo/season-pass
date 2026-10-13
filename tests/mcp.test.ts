// End-to-end over the real MCP protocol: the official SDK client talks Streamable HTTP to our handler.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp/server";

const URL_ = "http://localhost/api/mcp";

async function connect(household: string, who: { speaker: string; turn: number }) {
  const client = new Client({ name: "test-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-seasonpass-household", household);
      headers.set("x-seasonpass-speaker", who.speaker);
      headers.set("x-seasonpass-turn", String(who.turn));
      return handleMcpRequest(new Request(url, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return client;
}

async function rawPost(body: unknown, headers: Record<string, string> = {}) {
  const res = await handleMcpRequest(new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

describe("Season Pass MCP server", () => {
  it("negotiates spec 2025-11-25 on initialize", async () => {
    const { status, json } = await rawPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe("2025-11-25");
    expect(json.result.serverInfo.name).toBe("season-pass");
    expect(json.result.instructions).toContain("confirm_switch");
  });

  it("answers GET with 405 (stateless server, no standalone stream)", async () => {
    const res = await handleMcpRequest(new Request(URL_, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("lists the eight tools with schemas and annotations", async () => {
    const c = await connect("mcp-list", { speaker: "dana", turn: 1 });
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_household", "plan_rotation", "explain_plan", "record_preference", "propose_switch", "confirm_switch", "schedule_reminder", "undo_switch"]));
    expect(tools.find((t) => t.name === "explain_plan")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "confirm_switch")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "demo_reset")!._meta?.["seasonpass/hostOnly"]).toBe(true);
    await c.close();
  });

  it("re-plans from a voice turn, then a teen's yes is refused and an adult's yes goes through", async () => {
    const who = { speaker: "dana", turn: 1 };
    const c = await connect("mcp-flow", who);
    await c.callTool({ name: "demo_reset", arguments: {} });
    const brief: any = await c.callTool({ name: "get_household", arguments: { briefing: true } });
    expect(brief.structuredContent.briefing.urgent).toBe(true);

    who.speaker = "marcus"; who.turn = 2;
    const pref: any = await c.callTool({ name: "record_preference", arguments: { kind: "follow_title", title: "Quiet Orchard", utterance: "I'm still watching that show" } });
    expect(pref.isError).toBeFalsy();
    expect(pref.structuredContent.replan.deltaCents).toBe(1549);
    expect(pref.structuredContent.calendar.rows.length).toBe(5);

    who.speaker = "dana"; who.turn = 3;
    const p: any = await c.callTool({ name: "propose_switch", arguments: {} });
    const id = p.structuredContent.confirmationId;
    expect(p.structuredContent.card.kind).toBe("confirm");

    const same: any = await c.callTool({ name: "confirm_switch", arguments: { confirmation_id: id } });
    expect(same.structuredContent.error).toBe("needs_new_turn");

    who.speaker = "leah"; who.turn = 4;
    const teen: any = await c.callTool({ name: "confirm_switch", arguments: { confirmation_id: id } });
    expect(teen.isError).toBe(true);
    expect(teen.structuredContent.error).toBe("not_authorized");
    expect(teen.structuredContent.card.kind).toBe("blocked");

    who.speaker = "marcus"; who.turn = 5;
    const ok: any = await c.callTool({ name: "confirm_switch", arguments: { confirmation_id: id } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.change.by).toBe("marcus");

    const res: any = await c.readResource({ uri: "seasonpass://household" });
    const view = JSON.parse(res.contents[0].text);
    expect(view.services.find((s: any) => s.id === "lumen").autoRenew).toBe(false);

    who.speaker = "dana"; who.turn = 6;
    const undo: any = await c.callTool({ name: "undo_switch", arguments: {} });
    expect(undo.isError).toBeFalsy();
    await c.close();
  }, 30_000);

  it("returns a readable error for bad input instead of failing silently", async () => {
    const c = await connect("mcp-bad", { speaker: "dana", turn: 1 });
    const r: any = await c.callTool({ name: "explain_plan", arguments: { service: "nopeflix" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("don't know a service");
    await c.close();
  });
});
