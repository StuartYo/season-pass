# Day-1 stop-loss: planner vs. pure model

Run on 2026-10-13. 50 fictional households (`src/rotation/generate.ts`, seeds 1 to 50, plan 2026-11-01 to 2027-04-30, 4 to 6 services, 1 to 5 people, 4 to 9 shows, limits of 2, 3 or none).
Every plan is scored by the same code (`src/rotation/model.ts`): cost, missed (episode, follower) pairs, rule violations.

- **Planner**: exact mixed-integer program (HiGHS, local WebAssembly). Cross-checked against brute force on 25 small households (`tests/rotation.test.ts`).
- **Pure model**: `claude-opus-5-5`, effort medium, adaptive thinking, max 32,000 output tokens, no tools. Same data and the same rules text, asked for a JSON plan.
- **Status quo**: keep renewing what is already paid, add nothing.

Only 44 of 50 households got a model answer: the API workspace usage limit was reached during the run (households 45 to 50).

| | Planner | Pure model | Status quo |
|---|---|---|---|
| Households with a usable plan | 50 / 50 | 41 / 44 (3 ran out of 32k tokens with no answer) | 50 / 50 |
| Rule violations | 0 | 0 | 15 households over their limit |
| Matches the optimum (no extra misses, cost within 5%) | 50 / 50 | 33 / 44 (75%) | n/a |
| Missed more episodes than necessary | 0 | 5 households | most |
| Spent more than 5% over the optimum | 0 | 3 households (+9%, +18%, +21%) | most |
| Total cost, 41 households both answered | $3,802 | $3,806 | |
| Total missed pairs, same 41 | 57 | 64 | |
| Time per household | median 0.1 s, max 1.7 s | median 33 s, max 333 s | |
| API cost per household | $0 | $0.18 | |

Reading it honestly: the model never broke a rule and matched the optimum in three out of four households. It does not reach the 95% bar set as the stop condition, but the gap is moderate, not dramatic. Its failures are the kind a family would notice: an episode someone follows becomes unwatchable in time, a plan that costs up to 21% more, or no answer at all. The planner is exact, instant and free, so the assistant can re-plan on every voice change ("I'm still watching that one") without a 30-second wait.

Not yet run: the harder set (`EVAL_HARD=1`: 6 services, 3 to 5 people, 10 to 14 shows, limit 1 or 2) and the remaining 6 households, both blocked by the API usage limit until it is raised.

## Hard set: ready, not yet run against the model (2026-10-14)

`npx tsx eval/hard-set.ts` builds the harder households (same seeds the baseline uses with `EVAL_HARD=1`) and solves them with the planner only. No API calls. Output: `eval/out/hard-households.json`, `hard-planner.json`, `hard-summary.json`.

| | Normal set (run above) | Hard set |
|---|---|---|
| People per household (avg) | 2.6 | 3.8 |
| Followed shows per household (avg) | 6.5 | 12 |
| Services | 4 to 6 | 6 |
| Limit on services at once | none, 2 or 3 | 1 or 2 |
| (episode, follower) pairs to cover (avg) | 79 | 179 |
| Prompt size for the pure model (avg characters) | 4,788 | 6,842 |
| Planner: optimal / rule violations | 50 / 0 | 50 / 0 |
| Planner time, median (max, includes first WebAssembly load) | 98 ms (3.0 s) | 220 ms (4.3 s) |
| Missed pairs the limit makes unavoidable (avg, planner) | 2 | 36.9 |
| Status quo: missed pairs (avg) / households over their limit | 28 / 15 | 91 / 35 |

In the hard set the household limit forces real trade-offs: even the exact plan has to drop about 37 pairs per household, so "which ones to drop, and still pay the least" is the whole problem. The baseline run is waiting for the project key (`AMAZON_ANTHROPIC_API_KEY`); command: `EVAL_HARD=1 npx tsx eval/baseline.ts`. At the normal set's cost of about US$0.18 per household, 50 hard households should cost roughly US$10 to 15 (longer prompts); `EVAL_BUDGET_USD` caps it.
