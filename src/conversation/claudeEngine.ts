// "claude" conversation mode: Claude decides what to say and which MCP tool to call. The browser stays the MCP
// host: each tool_use is run against the MCP server over Streamable HTTP and the result goes back to Claude.
// The server route (/api/agent) only talks to Claude and needs AMAZON_ANTHROPIC_API_KEY. Not used until that exists.
import { RulesEngine } from "./rulesEngine";
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
  /** Used for a turn when the public demo's AI caps are reached (the route answers 429 with budget=true). */
  private fallback = new RulesEngine();
  /** True once a cap was hit; later turns go straight to rules mode. */
  capped = false;

  constructor(private endpoint = "/api/agent", private post: typeof fetch = (...a) => fetch(...a)) {}

  reset() {
    this.messages = [];
    this.fallback.reset();
  }

  async handle(input: EngineInput, tools: ToolRunner, world: World): Promise<EngineOutput> {
    const results: ToolResult[] = [];
    if (this.capped) return { ...(await this.fallback.handle(input, tools, world)), fellBackToRules: true };
    if (this.messages.length > 90) this.messages = [];
    const start = this.messages.length;
    this.messages.push({ role: "user", content: [{ type: "text", text: turnBlock(input, world) }] });
    for (let i = 0; i < 8; i++) {
      const res = await this.post(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: this.messages }) });
      const data = await res.json().catch(() => ({ error: "bad response" }));
      if (!res.ok) {
        if (data.budget && i === 0) {
          // Cap reached before anything ran this turn: answer this turn (and the rest) in rules mode.
          this.messages.length = start;
          this.capped = true;
          const out = await this.fallback.handle(input, tools, world);
          return { ...out, fellBackToRules: true, notice: data.error };
        }
        this.messages.length = start; // drop the whole failed turn so the history stays valid
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
    this.messages.length = start;
    return { speech: "Sorry, that took too many steps. Nothing else was changed.", results };
  }
}
