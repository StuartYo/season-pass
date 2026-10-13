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
      headers.set("x-renewwise-household", household);
      headers.set("x-renewwise-speaker", who.speaker);
      headers.set("x-renewwise-turn", String(who.turn));
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

describe("MCP server", () => {
  it("negotiates spec 2025-11-25 on initialize", async () => {
    const { status, json } = await rawPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe("2025-11-25");
    expect(json.result.serverInfo.name).toBe("renewwise");
    expect(json.result.instructions).toContain("confirm_change");
  });

  it("lists the tools with schemas and annotations", async () => {
    const c = await connect("mcp-list", { speaker: "dana", turn: 1 });
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_renewal_briefing", "get_household_usage", "recall_household_memory", "record_vote", "propose_change", "confirm_change", "undo_change", "schedule_reminder"]));
    expect(tools.find((t) => t.name === "get_renewal_briefing")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "demo_reset")!._meta?.["renewwise/hostOnly"]).toBe(true);
    await c.close();
  });

  it("runs a full proposal and confirmation, and refuses a teen's yes", async () => {
    const who = { speaker: "dana", turn: 1 };
    const c = await connect("mcp-flow", who);
    await c.callTool({ name: "demo_reset", arguments: {} });
    const p: any = await c.callTool({ name: "propose_change", arguments: { subscription: "kinobox", action: "cancel" } });
    expect(p.isError).toBeFalsy();
    const id = p.structuredContent.confirmationId;
    expect(p.structuredContent.card.kind).toBe("confirm");

    // Same turn: the assistant cannot confirm on its own.
    const same: any = await c.callTool({ name: "confirm_change", arguments: { confirmation_id: id } });
    expect(same.isError).toBe(true);
    expect(same.structuredContent.error).toBe("needs_new_turn");

    who.speaker = "leah"; who.turn = 2;
    const teen: any = await c.callTool({ name: "confirm_change", arguments: { confirmation_id: id } });
    expect(teen.structuredContent.error).toBe("not_authorized");

    who.speaker = "dana"; who.turn = 3;
    const ok: any = await c.callTool({ name: "confirm_change", arguments: { confirmation_id: id } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.change.monthlyChangeCents).toBe(-1399);

    const res: any = await c.readResource({ uri: "renewwise://household" });
    const view = JSON.parse(res.contents[0].text);
    expect(view.subscriptions.find((s: any) => s.id === "kinobox").status).toBe("cancel_pending");
    await c.close();
  });

  it("returns a readable error for bad input instead of failing silently", async () => {
    const c = await connect("mcp-bad", { speaker: "dana", turn: 1 });
    const r: any = await c.callTool({ name: "get_household_usage", arguments: { subscription: "nopeflix" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No subscription called");
    await c.close();
  });
});
