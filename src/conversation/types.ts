// The pluggable conversation layer. It turns what people say into MCP tool calls and a spoken reply.
// Two engines share this interface: "rules" (deterministic, no AI, used for the demo) and "claude" (Claude picks
// the tools; needs AMAZON_ANTHROPIC_API_KEY on the server). Neither engine can change money on its own: every
// amount, date and confirmation check lives in the MCP server.

export interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** structuredContent from the MCP result. */
  data: any;
  text: string;
}

/** Runs one MCP tool call as the current speaker. Implemented by the host (the simulator) over Streamable HTTP. */
export interface ToolRunner {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface WorldMember { id: string; name: string; role: string; age: number; canApproveCharges: boolean; aliases?: string[] }
export interface WorldService { id: string; name: string; required: boolean; scheduledStart: string | null; paidThrough: string | null; tags?: string[] }
export interface WorldShow { id: string; name: string; service: string; followers: string[] }

/** What the engine may know about the household (read from the MCP resource). Names only, no money. */
export interface World {
  today: string;
  members: WorldMember[];
  services: WorldService[];
  shows: WorldShow[];
}

export type EngineInput =
  | { type: "event"; event: "morning"; today: string }
  | { type: "utterance"; speakerId: string; speakerName: string; text: string; source: "scripted" | "voice" | "typed" };

export interface EngineOutput {
  speech: string;
  results: ToolResult[];
  /** Set when the engine could not run (e.g. Claude mode without a key). */
  error?: string;
}

export interface ConversationEngine {
  readonly mode: "rules" | "claude";
  handle(input: EngineInput, tools: ToolRunner, world: World): Promise<EngineOutput>;
  reset(): void;
}

/** MCP tools the conversation layer may call. Host-only demo tools are not in this list. */
export const ASSISTANT_TOOLS = [
  "get_household", "plan_rotation", "explain_plan", "record_preference", "propose_switch", "confirm_switch", "schedule_reminder", "undo_switch",
] as const;
