// "rules" conversation mode: deterministic, no AI. Parses an utterance into an intent, calls the matching MCP
// tool(s) and reads back the tool's own `speech`. Used for the demo and whenever no AI key is configured.
import { parseIntent } from "./intents";
import type { ConversationEngine, EngineInput, EngineOutput, ToolResult, ToolRunner, World } from "./types";

const HELP = "I can change the streaming plan when someone tells me what they're watching. Try: I'm still watching Quiet Orchard, or grandma wants the cooking channel this month.";

export class RulesEngine implements ConversationEngine {
  readonly mode = "rules" as const;
  private recentTitleIds: string[] = [];
  private recentServiceIds: string[] = [];
  private pending: string | null = null;

  reset() {
    this.recentTitleIds = [];
    this.recentServiceIds = [];
    this.pending = null;
  }

  private remember(r: ToolResult) {
    const d = r.data ?? {};
    const m = d.briefing?.mentions;
    if (m) {
      this.recentTitleIds = [...m.unfollowedTitleIds, ...m.titleIds.filter((x: string) => !m.unfollowedTitleIds.includes(x))];
      this.recentServiceIds = m.serviceIds;
    }
    if (d.preference?.titleId) this.recentTitleIds = [d.preference.titleId, ...this.recentTitleIds.filter((x) => x !== d.preference.titleId)];
    if (d.preference?.serviceId) this.recentServiceIds = [d.preference.serviceId];
    const acts: { serviceId: string }[] = d.nextActions ?? d.actions ?? [];
    if (acts.length) this.recentServiceIds = [...new Set([...acts.map((a) => a.serviceId), ...this.recentServiceIds])];
    if (r.name === "propose_switch" && !r.isError) this.pending = d.confirmationId ?? null;
    if (r.name === "confirm_switch" && (!r.isError || ["stale", "superseded", "expired", "unknown_confirmation"].includes(d.error))) this.pending = null;
  }

  async handle(input: EngineInput, tools: ToolRunner, world: World): Promise<EngineOutput> {
    const results: ToolResult[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await tools.call(name, args);
      results.push(r);
      this.remember(r);
      return r;
    };
    const say = (r: ToolResult) => String(r.data?.speech ?? r.text ?? "");

    if (input.type === "event") {
      const r = await call("get_household", { briefing: true });
      return { speech: say(r), results };
    }

    const intent = parseIntent(input.text, world, { recentTitleIds: this.recentTitleIds, recentServiceIds: this.recentServiceIds, speakerId: input.speakerId });
    const utterance = input.text.slice(0, 200);
    switch (intent.type) {
      case "follow":
      case "drop": {
        if (!intent.title) return { speech: "Which show do you mean?", results };
        const r = await call("record_preference", { kind: intent.type === "follow" ? "follow_title" : "drop_title", title: intent.title, ...(intent.member ? { member: intent.member } : {}), utterance });
        return { speech: say(r), results };
      }
      case "want": {
        const r = await call("record_preference", { kind: "want_service", service: intent.service, ...(intent.member ? { member: intent.member } : {}), ...(intent.startBy ? { start_by: intent.startBy } : {}), utterance });
        return { speech: say(r), results };
      }
      case "pace":
        return { speech: say(await call("record_preference", { kind: "set_pace", days: intent.days, ...(intent.member ? { member: intent.member } : {}), utterance })), results };
      case "limit":
        return { speech: say(await call("record_preference", { kind: "set_limit", limit: intent.limit, utterance })), results };
      case "plan":
        return { speech: say(await call("plan_rotation", {})), results };
      case "explain":
        return { speech: say(await call("explain_plan", intent.service ? { service: intent.service } : {})), results };
      case "propose":
        return { speech: say(await call("propose_switch", intent.service ? { service: intent.service } : {})), results };
      case "confirm": {
        // "Yes" to "Should I set it up?" proposes; "yes" to a spoken summary confirms. The server decides if the yes counts.
        if (!this.pending) return { speech: say(await call("propose_switch", {})), results };
        return { speech: say(await call("confirm_switch", { confirmation_id: this.pending })), results };
      }
      case "decline":
        this.pending = null;
        return { speech: "Okay, nothing changes. I'll bring it up again before the billing day.", results };
      case "undo":
        return { speech: say(await call("undo_switch", {})), results };
      case "remind": {
        const args: Record<string, unknown> = { note: intent.note };
        if (intent.service) args.before_service = intent.service; else if (intent.date) args.date = intent.date;
        return { speech: say(await call("schedule_reminder", args)), results };
      }
      case "household":
        return { speech: say(await call("get_household", {})), results };
      default:
        return { speech: HELP, results };
    }
  }
}
