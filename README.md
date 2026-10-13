# Season Pass

**The cheapest streaming rotation for the whole household, re-planned by voice in about a tenth of a second.**

Season Pass is an Alexa+ add-on built as a remote MCP server (spec **2025-11-25**, **Streamable HTTP**). A family says one sentence on the kitchen Echo Show, such as *"I'm still watching that show"* or *"Grandma wants the cooking channel this month"*, and code re-plans which streaming services are on in which month: the cheapest plan that misses no episode anyone follows. Services go off when nobody needs them and come back on when someone wants to watch. Every amount, date and confirmation is decided in server code; a teen's "yes" cannot approve a charge.

> **Demo data.** Every service (Lumen, Orbit, Kestrel+, Tidewell, Pebble Kids), show and family member in this repository is fictional. No real streaming service, payment or account is involved. Not affiliated with Amazon.

## Why code, not just a model

On 50 fictional households (`eval/RESULTS.md`), the same plan was made three ways and scored by the same code:

| | Season Pass planner | Pure model (Claude Opus, no tools) |
|---|---|---|
| Matches the optimum | **50 / 50** | 33 / 44 answered (**75%**) |
| Households with avoidable misses (episode, viewer pairs) | 0 | **5** |
| Time per plan (median) | **0.1 s** | 33 s |
| Cost per plan | **no API cost** (local solver) | US$0.18 |

The model is good: it never broke a rule and it matched the optimum three times out of four. But a family notices the fourth: a followed episode that becomes unwatchable, a plan up to 21% more expensive, or no answer. And 33 seconds is too slow to re-plan on every sentence someone says in the kitchen. The planner is an exact mixed-integer program (HiGHS, WebAssembly, runs inside the MCP server), cross-checked against brute force in the tests.

On a harder set (3 to 5 people, 10 to 14 shows, at most 1 or 2 services at once) the gap opens up. The budget covered 16 households:

| Hard set, 16 households | Season Pass planner | Pure model (same setting) |
|---|---|---|
| Matches the optimum | **16 / 16** | 5 / 16 (**31%**) |
| No answer (ran out of tokens) | 0 | 4 |
| Households with avoidable misses (episode, viewer pairs) | 0 | **6** |
| Time per plan (median) | **0.2 s** | 249 s |
| Cost per plan | **no API cost** | US$0.50 |

## What it looks like

The web simulator stands in for an Echo Show (Alexa+ developer tools are limited to launch partners; see `FRICTION_LOG.md`). It is a real MCP host: the official SDK client talks Streamable HTTP to the server, and a panel shows every tool call.

1. **Morning, three days before a billing day**, Alexa+ speaks first: *"Lumen renews Thursday for 15 dollars and 49 cents. The plan lets it go: Harbor Lights ends Wednesday and nobody is following Quiet Orchard."*
2. **Marcus**: *"Hold on, I'm still watching that show."* `record_preference` re-plans in about 100 ms. The calendar animates: Lumen goes off Thursday and comes back November 26 so he catches up within his 30 days. Plus 15.49 through April, every followed episode still in time.
3. **Dana**: *"Grandma wants the cooking channel this month."* Tidewell comes on Thursday; Lumen shifts to make room under the household limit of two services at once.
4. **Dana**: *"Okay, set it up."* `propose_switch` computes every amount and date. Nothing changes yet.
5. **Leah (15)**: *"Yes! Do it."* `confirm_switch` is **refused by the server** (`not_authorized`).
6. **Marcus**: *"Yes, confirm."* Done, with an undo until the billing day.
7. A reminder for the next billing moment, and the plan explains itself from the same data.

The demo turns are **scripted voice turns** (fixed text, labelled as scripted on screen). Live voice (Web Speech API, Chrome or Edge) and typing work too.

## Run it

Requires Node 20 or later.

```bash
npm ci
npm test          # 35 tests: planner vs brute force, money rules, MCP over HTTP, the scripted demo
npm run build
npm start         # http://localhost:3000, MCP endpoint at /mcp (alias of /api/mcp)
```

Development: `npm run dev`, or on Windows `scripts/dev.ps1`, which picks up `AMAZON_ANTHROPIC_API_KEY` from the user environment if it exists.

No key is needed. Without one, the simulator runs in **rules mode**: a deterministic intent parser turns each sentence into MCP tool calls and reads back the tool's own spoken text. With `AMAZON_ANTHROPIC_API_KEY` set on the server, **Claude mode** becomes available: Claude (Opus 5.5, low effort) picks the tools, the browser still runs them over MCP. The MCP server, the money rules and the refusals are identical in both modes. Settings are listed in `.env.example`.

Claude mode has been run on the full 8-step script (`eval/claude-demo.ts`, 2026-10-14): 16 API calls, about US$0.16 per run, 3 to 10 seconds per turn. The run recorded for the demo video, with the reminder morning added, is in `eval/out/claude-mode-video-run-2026-10-14.json` (18 calls, US$0.19). Claude picked the same tools as rules mode at every step; when Leah (15) said yes, Claude called `confirm_switch` and the **server** refused it (`not_authorized`); Marcus's yes went through. The public demo caps Claude mode (per browser per day, per day, per month; see `.env.example`). When a cap is reached the simulator says so and finishes in rules mode.

Talk to the MCP server directly:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Headers `X-SeasonPass-Household`, `X-SeasonPass-Speaker` and `X-SeasonPass-Turn` stand in for what Alexa+ knows from account linking and voice recognition.

## MCP tools

| Tool | What it does |
|---|---|
| `get_household` | Members and who can approve charges, each service's status, followed shows, the plan, pending confirmations. With `briefing=true`: the proactive morning opener and the decisions due around the next billing day. |
| `plan_rotation` | Recomputes the cheapest month-by-month rotation (exact solver) and returns the calendar and totals. |
| `explain_plan` | Why a service is on when it is: which shows and which people each paid month is for. Read-only. |
| `record_preference` | A voice-sourced change: `follow_title`, `drop_title`, `want_service`, `set_pace`, `set_limit`. Re-plans immediately and returns what changed and what it costs. Adults may speak for another member; a teen may not. |
| `propose_switch` | Step 1 of 2: collects the plan's actions in the next days (turn off at the billing day, turn on), computes amounts and dates, returns a confirmation id and a summary to read aloud. |
| `confirm_switch` | Step 2 of 2: only an adult with billing authority, in a later turn, within 10 minutes, and only if the plan did not change in between. Idempotent. |
| `schedule_reminder` | On a date, or the morning before a service's next billing day or start. Spoken in the briefing when due. |
| `undo_switch` | Reverts the latest switch until its first date. Billing adults only. |

Host-only demo tools (`demo_advance_clock`, `demo_reset`) are marked with `_meta["seasonpass/hostOnly"]` and are never offered to the conversation layer. Resource: `seasonpass://household`.

Every tool result has `speech` (safe to read aloud: no symbols, money in words) and a `card` (one title, at most two fields, at most one action). Refusals come back as `isError` with a rule code, so the screen can show that the server, not the model, said no.

## Architecture

```
Echo Show simulator (browser, Next.js page)
  ├─ conversation layer (pluggable)
  │    ├─ rules mode: intent parser, no AI           src/conversation/rulesEngine.ts, intents.ts
  │    └─ Claude mode: /api/agent, needs the key     src/conversation/claudeEngine.ts, src/agent/agent.ts
  └─ MCP host: official SDK client, Streamable HTTP  src/ui/mcpHost.ts
            │  JSON-RPC 2.0, protocol 2025-11-25, stateless
            ▼
Season Pass MCP server (/mcp)                        src/mcp/server.ts
  ├─ money and confirmation rules                    src/season/rules.ts
  ├─ exact planner (HiGHS mixed-integer program)     src/rotation/optimize.ts
  ├─ scorer used by planner, tests and the eval      src/rotation/model.ts
  └─ household store: Upstash Redis, JSON files, or memory   src/season/store.ts
```

The planner decides, for each optional service and each day, whether a one-month paid period starts there. Constraints: never pay twice for the same days, at most N services at once (already-paid access counts), and each (episode, follower) window must see at least one day of access or count as a miss. Objective: fewest misses first, then the lowest cost. A tie-break keeps the previous plan's months when the cost is exactly equal, so one sentence does not reshuffle unrelated services.

## Alexa+ mapping

| Alexa+ capability | In Season Pass | In this demo |
|---|---|---|
| Remote MCP add-on | The MCP server above, spec 2025-11-25 over Streamable HTTP | Same server; the simulator is the host |
| Proactive moment | Morning briefing before a billing day (`get_household`, `briefing=true`) and due reminders | Simulated: a "morning routine" button stands in for the trigger (no documented add-on entry point, `FRICTION_LOG.md` row 7) |
| Several people, one device | Each preference is recorded for the recognised speaker; only billing adults confirm | Simulated: a "who is speaking" picker sends the speaker in a header (no documented way to learn the speaker, `FRICTION_LOG.md` row 4) |
| Voice-first replies | Every result has a symbol-free `speech` field | Spoken with the browser's speech synthesis; voice-only toggle |
| Screen | Cards plus the rotation calendar with the re-plan animation | Echo Show style screen |
| Memory across conversations | Preferences, reminders, switches and the ledger live server-side per household | Household tab; the demo clock moves days and applies charges |
| Purchase-type action | Two-step switch with code-computed amounts, undo window | Simulated charges in the ledger, no real payment |

## Limits (honest)

- **Fictional data.** Release dates, prices and viewing are invented. Real use needs a schedule source and the household's actual billing dates.
- **Switches are simulated.** No real service is turned on or off. In production this would go through the services' own subscription management (for channels billed through an Amazon account, that is where it would plug in).
- **Watching is modelled simply.** An episode counts as watchable if the service is on for at least one day between its release and the follower's "watch within" days. Binge pace, profiles and downloads are not modelled.
- **Rules mode is narrow.** It understands the demo's kinds of sentences and replies with help otherwise. Claude mode understands free speech but is slower (3 to 10 seconds a turn) and capped on the public demo.
- **Demo caps are per server instance.** Without Upstash Redis the spend counters live in the instance's `/tmp`, so a cold start resets them; the Anthropic workspace's own monthly limit is the hard backstop.
- **Speaker identity is a header.** Alexa+ does not document how an add-on learns who is speaking (`FRICTION_LOG.md`), so the simulator stands in for voice recognition.
- **The baseline used one model setting** (Claude Opus, medium effort, no tools). Normal set: 44 of 50 households before an API limit. Hard set: 16 of 50, the most a US$9 budget covered. A different effort or a model with tools might do better; the comparison is against the model alone.
- **Serverless storage.** Without Upstash Redis, Vercel keeps households in `/tmp`, which is not shared between instances.
- The browser console shows two "405" lines per page load: the SDK client probes an optional stream that this stateless server correctly declines.

## Deploy

Live at https://season-pass-two.vercel.app (Vercel). The simulator is the page at `/`, the MCP endpoint is `/mcp`. HiGHS is kept as an external server package so its WebAssembly file ships with the function. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for durable households, and `AMAZON_ANTHROPIC_API_KEY` only if Claude mode should be on.

## Built on

Started on 2026-10-13 from RenewWise (an earlier idea in this same repository: a household deciding on subscription renewals). Kept from it: the stateless MCP transport, the simulator shell, the two-step confirmation pattern. New for Season Pass: the rotation model and exact planner, the 50-household evaluation, voice-sourced re-planning, the calendar screen, the pluggable conversation layer and the hard set.

## Repository

- `src/rotation/`: the problem, the scorer, the exact planner, the household generator (normal and hard)
- `src/season/`: household state, money and confirmation rules, demo seed, speech helpers, storage
- `src/mcp/server.ts`: the MCP server; `app/api/mcp/route.ts`: the endpoint
- `src/conversation/`: engine interface, rules engine, Claude engine, the scripted demo
- `src/ui/`: the simulator, the MCP host, the calendar
- `eval/`: baseline against the pure model (`baseline.ts`), hard-set preview (`hard-set.ts`), Claude mode on the demo script (`claude-demo.ts`), results
- `tests/`: Vitest

MIT License. See `LICENSE`.
