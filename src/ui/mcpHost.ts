"use client";
// The simulator is a real MCP host: it uses the official SDK client over Streamable HTTP and records every
// JSON-RPC exchange so the "MCP traffic" panel can show exactly what went over the wire.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface Exchange {
  id: number;
  at: number;
  ms: number;
  method: string;
  tool?: string;
  status: number;
  request: unknown;
  response: unknown;
  error: boolean;
  speaker: string | null;
  turn: number;
}

export interface HostContext {
  household: string;
  speaker: string | null;
  turn: number;
}

export class McpHost {
  client: Client | null = null;
  ctx: HostContext;
  log: Exchange[] = [];
  onLog: (log: Exchange[]) => void = () => {};
  private seq = 0;
  protocolVersion: string | null = null;

  constructor(public endpoint: string, ctx: HostContext) {
    this.ctx = ctx;
  }

  private fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("x-seasonpass-household", this.ctx.household);
    headers.set("x-seasonpass-speaker", this.ctx.speaker ?? "");
    headers.set("x-seasonpass-turn", String(this.ctx.turn));
    const t0 = performance.now();
    const res = await fetch(url, { ...init, headers });
    let request: unknown = null;
    try { request = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { /* not json */ }
    let response: unknown = null;
    const text = await res.clone().text().catch(() => "");
    try { response = text ? JSON.parse(text) : null; } catch { response = text; }
    const r = request as any;
    if (r && r.method) {
      const resp = response as any;
      if (r.method === "initialize" && resp?.result?.protocolVersion) this.protocolVersion = resp.result.protocolVersion;
      this.log = [
        ...this.log,
        {
          id: ++this.seq, at: Date.now(), ms: Math.round(performance.now() - t0), method: r.method, tool: r.params?.name,
          status: res.status, request: r, response: resp, error: !res.ok || Boolean(resp?.error) || Boolean(resp?.result?.isError),
          speaker: this.ctx.speaker, turn: this.ctx.turn,
        },
      ].slice(-200);
      this.onLog(this.log);
    }
    return res;
  };

  async connect() {
    if (this.client) return this.client;
    const client = new Client({ name: "alexa-plus-simulator", title: "Alexa+ simulator (Season Pass demo)", version: "0.2.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint, window.location.href), { fetch: this.fetcher });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const c = await this.connect();
    return (await c.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; structuredContent?: any; isError?: boolean };
  }

  async listTools() {
    const c = await this.connect();
    return (await c.listTools()).tools;
  }

  async household() {
    const c = await this.connect();
    const r = await c.readResource({ uri: "seasonpass://household" });
    const first = r.contents[0] as { text?: string };
    return JSON.parse(first.text ?? "{}");
  }
}
