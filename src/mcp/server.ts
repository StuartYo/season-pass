// The Season Pass MCP server: MCP spec 2025-11-25 over Streamable HTTP (stateless, JSON responses).
// One tool per household intent. Every result carries `speech` (safe to read aloud) and a `card` (Echo Show style).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as rules from "../season/rules";
import { CallContext, RuleError, SeasonState } from "../season/types";
import { reset, safeHouseholdId, withHousehold } from "../season/store";

export const SPEC_VERSION = "2025-11-25";
if (LATEST_PROTOCOL_VERSION !== SPEC_VERSION) {
  // Fail loudly if an SDK upgrade silently changes the negotiated spec version.
  console.warn(`[season-pass] SDK latest protocol is ${LATEST_PROTOCOL_VERSION}, expected ${SPEC_VERSION}`);
}

export const SERVER_NAME = "season-pass";
/** Tools the simulator (the host) may call but the assistant may not. */
export const HOST_ONLY_TOOLS = new Set(["demo_advance_clock", "demo_reset"]);

const INSTRUCTIONS = `Season Pass plans a household's streaming services month by month: each service is on only while someone in the family needs it, and the plan is the cheapest one that misses no followed episode it doesn't have to.
Use get_household with briefing=true for the proactive morning moment. When someone says something that changes what the family watches ("I'm still watching that show", "grandma wants the cooking channel this month"), call record_preference: the code re-plans in about a tenth of a second and returns what changed.
Money is two steps: propose_switch returns a confirmation_id and a spoken summary; only after an adult with billing authority says yes in a later turn, call confirm_switch. Never state a price, date or saving that did not come from a tool result. Each result has a "speech" field that is safe to read aloud.
All household data is fictional demo data.`;

type Ctx = () => CallContext;
type Data = Record<string, unknown> & { speech: string };

function ok(data: Data) {
  return { content: [{ type: "text" as const, text: data.speech }], structuredContent: data };
}

function fail(e: unknown) {
  if (e instanceof RuleError) {
    const card: rules.Card = { kind: "blocked", title: "Not done", fields: [{ label: "Why", value: e.message }], tone: "warn", footnote: `Refused by server rule: ${e.code}` };
    return { isError: true, content: [{ type: "text" as const, text: e.message }], structuredContent: { error: e.code, message: e.message, speech: e.message, card } };
  }
  console.error("[season-pass] tool error", e);
  return { isError: true, content: [{ type: "text" as const, text: "Something went wrong on the Season Pass side. Nothing was changed." }] };
}

async function run(ctx: Ctx, fn: (s: SeasonState, c: CallContext) => Data | Promise<Data>, write = true) {
  const c = ctx();
  try {
    return ok(await withHousehold(c.householdId, (s) => fn(s, c), write));
  } catch (e) {
    return fail(e);
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function createServer(ctx: Ctx) {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Season Pass", version: "0.2.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } },
  );

  server.registerTool("get_household", {
    title: "Household and plan",
    description: "Call at the start of a morning briefing (briefing=true) or when someone asks what the family pays for, who watches what, or what happens next. Returns members and who can approve charges, each service's status, followed shows, the current plan, pending confirmations, reminders and recent changes. With briefing=true it also returns the decisions due around the next billing day and a spoken opener.",
    inputSchema: { briefing: z.boolean().optional().describe("True for the proactive morning moment.") },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ briefing }) => run(ctx, (s) => rules.getHousehold(s, { briefing: briefing ?? false })));

  server.registerTool("plan_rotation", {
    title: "Plan the rotation",
    description: "Call when someone asks for the plan, or what it costs. Recomputes the cheapest month-by-month rotation through the end of the plan with an exact solver (fewest missed followed episodes first, then lowest cost, never more services at once than the household limit). Returns the calendar, the totals, the next actions and a spoken summary.",
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => run(ctx, (s) => rules.planRotation(s)));

  server.registerTool("explain_plan", {
    title: "Why the plan looks like this",
    description: "Call when someone asks why a service is on or off, or why it comes back on a date. Returns, for each period, which shows and which family members it is for, computed from the plan.",
    inputSchema: { service: z.string().min(2).max(40).optional().describe("Service name or id, e.g. \"Lumen\". Omit for the whole plan.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ service }) => run(ctx, (s) => rules.explainPlan(s, service), false));

  server.registerTool("record_preference", {
    title: "Record what someone said",
    description: "Call when a family member says something that changes what the household needs: they are still watching a show (follow_title), they gave up on one (drop_title), someone wants a service for a while (want_service), they can wait longer for new episodes (set_pace), or an adult changes how many services may be on at once (set_limit). The person is the current speaker as identified by the device; an adult may speak for another member with `member`. The plan is recomputed immediately and the result says what changed and what it costs.",
    inputSchema: {
      kind: z.enum(["follow_title", "drop_title", "want_service", "set_pace", "set_limit"]),
      title: z.string().min(2).max(60).optional().describe("Show name, for follow_title and drop_title."),
      service: z.string().min(2).max(40).optional().describe("Service name or what people call it (\"the cooking channel\"), for want_service."),
      member: z.string().min(2).max(30).optional().describe("Who it is for, if not the speaker, e.g. \"grandma\". Only adults can speak for others."),
      start_by: date.optional().describe("For want_service: the latest day it should be on. Default: three days from today."),
      days: z.number().int().min(1).max(60).optional().describe("For set_pace: watches new episodes within this many days."),
      limit: z.number().int().min(1).max(6).nullable().optional().describe("For set_limit: services on at once, or null for no limit."),
      utterance: z.string().max(200).optional().describe("What the person said, for the household's memory."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => run(ctx, (s, c) => rules.recordPreference(s, c, { kind: a.kind, title: a.title, service: a.service, member: a.member, startBy: a.start_by, days: a.days, limit: a.limit, utterance: a.utterance })));

  server.registerTool("propose_switch", {
    title: "Set up the next switch (step 1 of 2)",
    description: "Call when the family agrees to follow the plan. Nothing changes yet: code collects the plan's actions in the next days (turn a service off at its billing day, turn one on), computes every amount and date, and returns a confirmation_id plus a summary to read aloud. Read the speech field, then wait for an adult with billing authority to say yes.",
    inputSchema: {
      service: z.string().min(2).max(40).optional().describe("Only this service's action."),
      within_days: z.number().int().min(1).max(31).optional().describe("Look-ahead in days. Default 10."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ service, within_days }) => run(ctx, (s, c) => rules.proposeSwitch(s, c, { service, withinDays: within_days })));

  server.registerTool("confirm_switch", {
    title: "Confirm the switch (step 2 of 2)",
    description: "Call only after an adult with billing authority clearly said yes to the summary from propose_switch, in a turn after that summary. The server checks who is speaking (a teen's or child's yes is refused), that it is a new turn, that the confirmation has not expired, and that the plan did not change in between. Safe to retry: a confirmed switch is never applied twice.",
    inputSchema: { confirmation_id: z.string().min(3).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ confirmation_id }) => run(ctx, (s, c) => rules.confirmSwitch(s, c, confirmation_id)));

  server.registerTool("schedule_reminder", {
    title: "Bring it up later",
    description: "Call when the family wants a reminder: on a date, or the morning before a service's next billing day or start (before_service). The reminder is spoken in the morning briefing when due.",
    inputSchema: {
      date: date.optional().describe("YYYY-MM-DD on the household's calendar."),
      before_service: z.string().min(2).max(40).optional().describe("Remind the day before this service's next billing day or start."),
      note: z.string().min(3).max(200).describe("What to bring up, in plain words."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ date: d, before_service, note }) => run(ctx, (s, c) => rules.scheduleReminder(s, c, { date: d, beforeService: before_service, note })));

  server.registerTool("undo_switch", {
    title: "Undo a switch",
    description: "Call when an adult with billing authority asks to undo the latest confirmed switch. Works until the switch's first date; after that, plan a new switch instead.",
    inputSchema: { change: z.string().min(3).max(40).optional().describe("Change id from the receipt. Default: the latest switch.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ change }) => run(ctx, (s, c) => rules.undoSwitch(s, c, change)));

  // Host-only controls for the demo. The simulator's conversation layer never sees these.
  server.registerTool("demo_advance_clock", {
    title: "Demo: move the household clock",
    description: "Host-only demo control. Moves the simulated calendar forward and applies starts, renewals and lapses, then re-plans.",
    inputSchema: { to_date: date },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { "seasonpass/hostOnly": true },
  }, async ({ to_date }) => run(ctx, async (s, c) => { const r = await rules.advanceClock(s, to_date, c.nowMs); return { ...r, speech: `It is now ${r.today}.` }; }));

  server.registerTool("demo_reset", {
    title: "Demo: reset the household",
    description: "Host-only demo control. Restores the fictional household to its starting state.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { "seasonpass/hostOnly": true },
  }, async () => {
    try { const s = await reset(ctx().householdId); return ok({ today: s.today, speech: "Demo household reset." }); } catch (e) { return fail(e); }
  });

  server.registerResource("household", "seasonpass://household", {
    title: "Household overview",
    description: "Members, services, shows, the current plan with its calendar, pending confirmations, reminders and the change ledger. For the device screen.",
    mimeType: "application/json",
  }, async (uri) => {
    const view = await withHousehold(ctx().householdId, async (st) => {
      const v = await rules.getHousehold(st);
      return { ...v, card: undefined, speech: undefined };
    }, true);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view) }] };
  });

  return server;
}

/** Reads the host-supplied context. In Alexa+ these would come from account linking and voice recognition. */
export function contextFromHeaders(h: Headers): CallContext {
  const speaker = (h.get("x-seasonpass-speaker") ?? "").toLowerCase().trim();
  const turn = Number(h.get("x-seasonpass-turn") ?? "0");
  return {
    householdId: safeHouseholdId(h.get("x-seasonpass-household")),
    speakerId: /^[a-z]{2,20}$/.test(speaker) ? speaker : null,
    turn: Number.isFinite(turn) && turn >= 0 ? Math.floor(turn) : 0,
    nowMs: Date.now(),
  };
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-SeasonPass-Household, X-SeasonPass-Speaker, X-SeasonPass-Turn",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

/** Handles one HTTP request on the MCP endpoint. Stateless: a fresh server and transport per request. */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  // Stateless server: no standalone SSE stream and no sessions to delete. The spec answer is 405.
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless; send JSON-RPC with POST." }, id: null }), {
      status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS", "Content-Type": "application/json" },
    });
  }
  const ctx = contextFromHeaders(req.headers);
  const server = createServer(() => ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  } finally {
    // JSON response mode has fully produced the body by now; closing frees the per-request server.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
