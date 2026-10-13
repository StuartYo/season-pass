// The RenewWise MCP server: MCP spec 2025-11-25 over Streamable HTTP (stateless, JSON responses).
// One tool per customer intent. Every result carries `speech` (voice-only safe) and a `card` (Echo Show style).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as rules from "../domain/rules";
import { CallContext, HouseholdState, RuleError } from "../domain/types";
import { reset, safeHouseholdId, withHousehold } from "../domain/store";

export const SPEC_VERSION = "2025-11-25";
if (LATEST_PROTOCOL_VERSION !== SPEC_VERSION) {
  // Fail loudly if an SDK upgrade silently changes the negotiated spec version.
  console.warn(`[renewwise] SDK latest protocol is ${LATEST_PROTOCOL_VERSION}, expected ${SPEC_VERSION}`);
}

/** Tools the simulator (the host) may call but the assistant may not. */
export const HOST_ONLY_TOOLS = new Set(["demo_advance_clock", "demo_reset"]);

const INSTRUCTIONS = `RenewWise helps a household decide, together, what to do before a subscription renews.
Start a proactive moment with get_renewal_briefing. Money changes are two steps: propose_change returns a confirmation_id and a spoken summary; only after an adult with billing authority says yes in a later turn, call confirm_change. Never state a price, date or refund that did not come from a tool result. Each tool result has a "speech" field that is safe to read aloud.
All household data is fictional demo data.`;

type Ctx = () => CallContext;

function ok(data: Record<string, unknown> & { speech: string }) {
  return { content: [{ type: "text" as const, text: data.speech }], structuredContent: data };
}

function fail(e: unknown) {
  if (e instanceof RuleError) {
    const card: rules.Card = { kind: "blocked", title: "Not done", fields: [{ label: "Why", value: e.message }], tone: "warn", footnote: `Rule: ${e.code}` };
    return { isError: true, content: [{ type: "text" as const, text: e.message }], structuredContent: { error: e.code, message: e.message, speech: e.message, card } };
  }
  console.error("[renewwise] tool error", e);
  return { isError: true, content: [{ type: "text" as const, text: "Something went wrong on the RenewWise side. Nothing was changed." }] };
}

async function run(ctx: Ctx, fn: (s: HouseholdState, c: CallContext) => Record<string, unknown> & { speech: string }, write = true) {
  const c = ctx();
  try {
    const data = await withHousehold(c.householdId, (s) => fn(s, c), write);
    return ok(data);
  } catch (e) {
    return fail(e);
  }
}

const subArg = z.string().min(2).max(40).describe("Subscription id or name, for example \"streamvale\" or \"KinoBox\".");

export function createServer(ctx: Ctx) {
  const server = new McpServer(
    { name: "renewwise", title: "RenewWise", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } },
  );

  server.registerTool("get_renewal_briefing", {
    title: "Renewal briefing",
    description: "Call when the household's morning briefing starts, when someone asks what renews soon, or when a scheduled reminder may be due. Returns renewals in the next days, charges that can still be refunded, reminders that are due today, and a code-computed suggestion for each.",
    inputSchema: { within_days: z.number().int().min(1).max(31).optional().describe("Look-ahead window in days. Default 7.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ within_days }) => run(ctx, (s) => ({ ...rules.briefing(s, within_days ?? rules.BRIEFING_WINDOW_DAYS), household: s.householdName, dataNotice: s.dataNotice })));

  server.registerTool("get_household_usage", {
    title: "Who uses a subscription",
    description: "Call when someone asks who actually uses a subscription, or before suggesting a change. Returns per-member hours from the (simulated) Fire TV or Echo history, cost per hour, upcoming events such as a season finale, refund eligibility and the code-computed suggestion.",
    inputSchema: { subscription: subArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ subscription }) => run(ctx, (s) => rules.usageReport(s, subscription), false));

  server.registerTool("recall_household_memory", {
    title: "What we decided before",
    description: "Call when someone refers to an earlier conversation (\"what did we say about it\"), or before reopening a decision. Returns past decisions, opinions, open reminders and recent changes, optionally for one subscription.",
    inputSchema: { subscription: subArg.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ subscription }) => run(ctx, (s) => rules.memory(s, subscription), false));

  server.registerTool("record_vote", {
    title: "Record what someone wants",
    description: "Call when the person speaking says what they want for a subscription (keep, cancel, pause or downgrade). The vote is stored for the current speaker as identified by the device, never for someone else. Returns everyone's positions and the household policy's resolution, including a code-computed compromise when an adult wants to cut something a family member uses a lot.",
    inputSchema: {
      subscription: subArg,
      preference: z.enum(["keep", "cancel", "pause", "downgrade"]),
      reason: z.string().max(200).describe("The speaker's reason in a few words."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ subscription, preference, reason }) => run(ctx, (s, c) => rules.recordVote(s, c, subscription, preference, reason)));

  server.registerTool("propose_change", {
    title: "Set up a change (step 1 of 2)",
    description: "Call when the family has settled on cancelling, pausing, switching plan, or refunding a subscription. Nothing changes yet: code computes the exact amount, date and reversibility and returns a confirmation_id plus a summary to read aloud. Read the speech field, then wait for an adult to say yes.",
    inputSchema: {
      subscription: subArg,
      action: z.enum(["cancel", "pause", "downgrade", "switch_plan", "refund_and_cancel"]),
      to_plan: z.string().max(40).optional().describe("Plan id for downgrade or switch_plan, for example \"basic_ads\". If omitted for a downgrade, the code picks the cheapest plan that still fits the household."),
      pause_months: z.number().int().min(1).max(12).optional().describe("Pause length in months, only if the provider offers it."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ subscription, action, to_plan, pause_months }) =>
    run(ctx, (s, c) => rules.propose(s, c, { subscriptionId: subscription, action, toPlanId: to_plan, pauseMonths: pause_months })));

  server.registerTool("confirm_change", {
    title: "Confirm a change (step 2 of 2)",
    description: "Call only after an adult with billing authority clearly said yes to the summary from propose_change, in a turn after that summary. The server checks who is speaking, that it is a new turn, that the confirmation has not expired, and that nothing changed in between; it refuses otherwise. Safe to retry: a confirmed change is never applied twice.",
    inputSchema: { confirmation_id: z.string().min(3).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ confirmation_id }) => run(ctx, (s, c) => rules.confirm(s, c, confirmation_id)));

  server.registerTool("undo_change", {
    title: "Undo a change",
    description: "Call when an adult asks to undo or reverse a recent change. Works until the change takes effect at the renewal date; refunds are final and cannot be undone.",
    inputSchema: { change: z.string().min(2).max(40).describe("The change id from the receipt, or the subscription name to undo its latest change.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ change }) => run(ctx, (s, c) => rules.undo(s, c, change)));

  server.registerTool("schedule_reminder", {
    title: "Bring it up later",
    description: "Call when the family wants to decide later, for example after a season finale or on a date. Use event_id for events listed by get_household_usage (the reminder fires the day after), or a date. The reminder shows up in the briefing when due.",
    inputSchema: {
      subscription: subArg,
      event_id: z.string().max(60).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD on the household's calendar."),
      note: z.string().min(3).max(200).describe("What to bring up, in plain words."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ subscription, event_id, date, note }) => run(ctx, (s, c) => rules.scheduleReminder(s, c, subscription, { eventId: event_id, date, note })));

  // Host-only controls for the demo. The simulator's agent never sees these.
  server.registerTool("demo_advance_clock", {
    title: "Demo: move the household clock",
    description: "Host-only demo control. Moves the simulated calendar forward and applies renewals, scheduled changes and reminders.",
    inputSchema: { to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { "renewwise/hostOnly": true },
  }, async ({ to_date }) => run(ctx, (s, c) => { const r = rules.advanceClock(s, to_date, c.nowMs); return { ...r, speech: `It is now ${r.today}.` }; }));

  server.registerTool("demo_reset", {
    title: "Demo: reset the household",
    description: "Host-only demo control. Restores the fictional household to its starting state.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { "renewwise/hostOnly": true },
  }, async () => {
    try { const s = await reset(ctx().householdId); return ok({ today: s.today, speech: "Demo household reset." }); } catch (e) { return fail(e); }
  });

  server.registerResource("household", "renewwise://household", {
    title: "Household overview",
    description: "Members, subscriptions with status, the simulated date, open reminders and the change ledger. For the device screen.",
    mimeType: "application/json",
  }, async (uri) => {
    const s = await withHousehold(ctx().householdId, (st) => { rules.refreshDue(st); return st; }, false);
    const view = {
      householdName: s.householdName, today: s.today, dataNotice: s.dataNotice, members: s.members,
      subscriptions: s.subscriptions.map((x) => ({ id: x.id, name: x.name, category: x.category, status: x.status, plan: rules.currentPlan(x), nextRenewal: x.nextRenewal, scheduled: x.scheduled ?? null, pausedUntil: x.pausedUntil ?? null, usageSource: x.usageSource })),
      reminders: s.reminders, ledger: s.ledger.slice(-20), votes: s.votes,
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(view) }] };
  });

  return server;
}

/** Reads the host-supplied context. In Alexa+ these come from account linking and voice recognition. */
export function contextFromHeaders(h: Headers): CallContext {
  const speaker = (h.get("x-renewwise-speaker") ?? "").toLowerCase().trim();
  const turn = Number(h.get("x-renewwise-turn") ?? "0");
  return {
    householdId: safeHouseholdId(h.get("x-renewwise-household")),
    speakerId: /^[a-z]{2,20}$/.test(speaker) ? speaker : null,
    turn: Number.isFinite(turn) && turn >= 0 ? Math.floor(turn) : 0,
    nowMs: Date.now(),
  };
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-RenewWise-Household, X-RenewWise-Speaker, X-RenewWise-Turn",
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
