// "claude" conversation mode: Claude decides what to say and which MCP tool to call. The browser stays the MCP
// host: each tool_use is run against the MCP server over Streamable HTTP and the result goes back to Claude.
// The server route (/api/agent) only talks to Claude and needs AMAZON_ANTHROPIC_API_KEY. Not used until that exists.
import type { ConversationEngine, EngineInput, EngineOutput, ToolResult, ToolRunner, World } from "./types";

const escAttr = (s: string) => s.replace(/[<>&"]/g, " ");

export function turnBlock(input: EngineInput, world: World): string {
  if (input.type === "event") return `<event name="morning_briefing" date="${input.today}">The household's morning routine started. Nobody has spoken yet.</event>`;
  const m = world.members.find((x) => x.id === input.speakerId);
  const role = m ? `${m.role}${m.canApproveCharges ? ", can approve charges" : ""}` : "unknown";
  return `<turn speaker="${escAttr(input.speakerName)}" role="${escAttr(role)}" date="${world.today}">${input.text.replace(/</g, " ")}</turn>`;
}

export class ClaudeEngine implements ConversationEngine {
  readonly mode = "claude" as const;
  private messages: any[] = [];

  constructor(private endpoint = "/api/agent") {}

  reset() {
    this.messages = [];
  }

  async handle(input: EngineInput, tools: ToolRunner, world: World): Promise<EngineOutput> {
    const results: ToolResult[] = [];
    if (this.messages.length > 90) this.messages = [];
    this.messages.push({ role: "user", content: [{ type: "text", text: turnBlock(input, world) }] });
    for (let i = 0; i < 8; i++) {
      const res = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: this.messages }) });
      const data = await res.json().catch(() => ({ error: "bad response" }));
      if (!res.ok) {
        this.messages.pop();
        return { speech: "", results, error: data.error ?? "The assistant is unavailable." };
      }
      this.messages.push({ role: "assistant", content: data.content });
      const text = (data.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      const uses = (data.content as any[]).filter((b) => b.type === "tool_use");
      if (!uses.length) return { speech: text, results };
      const blocks: any[] = [];
      for (const u of uses) {
        const r = await tools.call(u.name, u.input ?? {});
        results.push(r);
        blocks.push({ type: "tool_result", tool_use_id: u.id, is_error: r.isError, content: JSON.stringify(r.data ?? { text: r.text }).slice(0, 12000) });
      }
      this.messages.push({ role: "user", content: blocks });
    }
    return { speech: "Sorry, that took too many steps. Nothing else was changed.", results };
  }
}
