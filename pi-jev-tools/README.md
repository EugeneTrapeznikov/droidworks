# Pi JEV Tools

Tool-result triage for Pi, driven by a decision model. One capability: a large tool result is split into blocks, a Jev-style judge answers "is this block needed?" per block, and dead runs are hidden behind a stub the model can restore with `pi_jev_recall`. It is a port of [winnow](https://github.com/GhalebDweikat/winnow) onto Pi's `tool_result` event.

## Status (2026-09-24)

On 20 long real sessions, hosted Jev triage freed 9.7% of context (aggregate; session p50 8.7%) at drop 0.20, the default, with the same 10/20 resolve rate on SWE-bench Lite 20 at drops 0.10, 0.15, and 0.20 and a median of zero recall calls per task.

It is a modest, measured win on context headroom, not on cost. The extension ships triage only ([extension/README.md](extension/README.md)) with hosted Jev (`vercel`) and drop 0.20. Evidence, cheapest first:

**(a) Corpus** ([figures/corpus](bench/figures/corpus-2026-09-23.md)). Tool results are 95% of transcript chars, and 81.5% of tool-result chars pass the triage gates. So triage acts on almost all of the context.

**(b) SWE-bench Lite 20, safety** ([bench/swe/RESULTS.md](bench/swe/RESULTS.md)). Resolved: `full` 9/20, `off` 9/20, `triage-vercel` 10/20 (sign test p = 1.0); the threshold arms at 0.10 and 0.15 also resolved 10/20 each. Tokens and cost vs `full` are within noise (input+cacheRead −0.7%, p = 0.50). Triage adds about 11 s per task (median). It hid 16% of tool-result chars per task (p50), the model made 5 `pi_jev_recall` calls, and 20% of judge calls failed open (23/116). Side finding: `full` vs bare `off` Pi scores the same 9/20 at 3.2× tokens and 1.9× cost, all of it the skills and extensions prefix re-read every turn.

**(c) Session replay, context** ([results](bench/session-replay/results-2026-09-23.md)). The top 20 sessions by model calls (15,261 calls) were replayed through hosted Jev on the recorded tool results, then the context was rebuilt offline. At 0.10, triage hid 10.2% of judged chars and freed 3.1% of context per call (session p50; 3.3% aggregate). Tokens saved: 4.70M input and 72.21M cacheRead. Judge spend was $0.65. Threshold sweep over the same judged probabilities:

| drop ≤ | judged chars hidden | context saved, aggregate / session p50 | flagged (loose) | unique loss (strict) |
|---|--:|--:|--:|--:|
| 0.10 | 10.2% | 3.3% / 3.1% | 38.6% | 4.3% |
| 0.15 | 21.0% | 6.5% / 5.9% | 46.1% | 4.6% |
| 0.20 (default) | 31.9% | 9.7% / 8.7% | 53.0% | 5.9% |
| 0.25 | 40.8% | 12.3% / 10.4% | 56.3% | 6.9% |
| 0.30 | 47.8% | 14.5% / 12.9% | 57.9% | 8.2% |

SWE-bench Lite 20 at each threshold on the final code ([RESULTS.md](bench/swe/RESULTS.md#2026-09-23-threshold-arms-drop-010-vs-015-final-code)):

| drop ≤ | resolved | tool-result chars hidden p50 | stubs | recalls | cost total (retail-equiv.) |
|---|--:|--:|--:|--:|--:|
| 0.10 / 0.15 / 0.20 | 10/20 / 10/20 / 10/20 | 8% / 19% / — | 22 / 49 / 49 | 4 / 6 / 8 | $3.23 / $2.78 / $2.57 |

At 0.15 triage hid more than twice the chars of 0.10 at the same resolve rate. At 0.20 it hid 17% more bytes than 0.15, again resolving the same 10 tasks ([RESULTS.md](bench/swe/RESULTS.md#2026-09-24-threshold-arm-drop-020)). No task that recalled a hidden block failed where a control passed.

*Flagged*: some identifier from a hidden block shows up in the session's later assistant text or tool inputs. *Unique loss*: a returning identifier that the model could not have seen anywhere else at that moment (not in kept blocks, earlier messages, or compaction summaries). At 0.10, 75% of judged results were kept whole because under 20% of their chars would have been hidden. The prune ratio is not the lever here. Hosted Jev puts its block probabilities around a 0.20 median, and only 11% of blocks score ≤ 0.10, so few results have much to hide at that threshold. The drop threshold is what moves the hide rate: 0.15 doubles it while unique loss moves from 4.3% to 4.6%.

**(d) What did not work.**
- kev-0.8b local judge: AUC 0.509 with the `winnow` question, hid 0.1%. Dropped.
- JevK5 v0.2.0: never scored a block below 0.1 (min 0.107), so it hid nothing at drop 0.10, and it timed out at 15 s on large reads. Dropped.
- Tier-1 replay labels and the lexical baseline: labels are lexical (a later edit reuses a line, a later read names a path, the answer quotes an identifier). A token-overlap baseline scores well by echoing the labeler, not by knowing need, while both judges sat at chance (AUC 0.478 hosted, 0.510 JevK5, n = 97). The baseline and the labels' role as ground truth were dropped.
- Hosted Jev availability: HTTP 429 and 503 load shedding all day (session replay: 1,710 × 429 and 2,704 × 503 retries). Fail-opens were 401 of 3,941 eligible results in session replay and 20% of judge calls on SWE-bench. Some inputs 503 deterministically.

**(e) Honest limits.**
- The cost saving is mostly cache-read tokens, priced at ~0.1× input: $61 of $1,756 input+cacheRead cost (3.5%), retail-equivalent. The sessions ran on a subscription, so nothing was billed at these rates.
- Forked sessions replay their parent's history, so some triaged results are counted twice.
- The replay does not re-run the model. Every later turn is the original one, so the cost of a needed block that was hidden (a recall, or a different trajectory) is not observed.
- The harm proxy is textual (identifier matching), not a task outcome. Only SWE-bench measures outcomes.

## What "Jev" is

Not an acronym. Jev is TypeSafe's "System One" decision model: a fast, cheap non-LLM that answers bounded questions (yes/no, choice, score) with per-option probabilities. This extension asks it one yes/no question per block of a large tool result.

## Why triage

Mined from 1,073 local Pi sessions, 95,905 model calls, 11,215 user prompts (`scripts/mine-sessions.py`, `scripts/mine-sessions-cost.py`; cost is Pi's retail-equivalent estimate under subscription):

| Fact | Value |
|---|---:|
| model calls per user prompt | 8.6 |
| context per call, p50 / p90 | 109k / 231k tokens |
| latency per call, p50 | 7.8 s |
| cost split input / cacheRead / output | 42% / 49% / 9% |
| static 16k prefix, share of cost | 12.4% |
| tool results, share of transcript chars | 95% |
| tool-only turns (no text) | 85% of calls |
| compactions | 174 |

Tool-result volume by tool: read 43%, bash 35%, fetch_url 10%, mcp 5%. Tool results are the context, so triage is the largest lever: every 10% of resident context is about 9% of cost. Risk: an elided line costs a re-read turn. Measure billed tokens and turn count, not filter ratio (JetBrains measured RTK at +7.6% cost despite 60–90% output reduction).

## Design

One `tool_result` hook (`extension/src/triage/`). It rewrites each result at ingestion, before the model ever sees it, so earlier messages and the cached prefix are never touched.

1. Skip unless the tool is allowlisted (`read,bash,grep,find,ls,fetch_url,mcp*`) and the result is ≥ 2,000 chars. Unified diffs and JSON/JSONL bodies pass through unjudged (`skipStructured`), because a hole would break `git apply` or `jq`.
2. Split into blocks of ≤ 25 lines and ≤ 1,500 chars. A longer single line is hard-split into ≤ 1,500-char pieces, and stubs and recall still address the whole line.
3. Judge: one `noul` per block plus an error question answered by the model (P ≥ 0.5 keeps the whole result; no regex). Wording comes from `PI_JEV_QUESTION_SET` (default `winnow`). State is `{ task, tool, blocks }` in full text under a per-backend cap (`PI_JEV_STATE_CHARS`, 80k hosted, 24k local). Only the leading run of blocks that fits is judged; the rest stay visible. `maxBlocksPerCall` splits the blocks into sequential chunked calls under one deadline.
4. `decide()`: the first and last block are always kept. Hide at P ≤ drop (0.20), keep at P ≥ keep (0.5), and leave the uncertain middle visible. Skip the rewrite if under 20% of chars would be hidden or the error gate fires. `drop` and `keep` can be set per judge in `settings.json` (`"pi-jev".judges.<name>`).
5. Each hidden run becomes a `[pi-jev: hid lines …]` stub. Originals are cached for `pi_jev_recall`.

Fail-open: a judge timeout (15 s) or error leaves the result untouched. `PI_JEV_SHADOW=1` (the default) decides and logs without mutating. Every decision is a `DecisionRecord` in `PI_JEV_LOG`.

## Jev access

Jev is on Vercel AI Gateway as `typesafe-ai/jev` (`type: "evaluation"`, $0.042/M input, output free). It is not OpenAI-chat compatible, so it cannot go through a LiteLLM shim; the extension calls `POST https://ai-gateway.vercel.sh/v1/evaluate` with plain fetch. Key lives in `~/.config/vercel/.env` as `VERCEL_API_KEY`; the extension loads it at runtime (`extension/src/judge/dotenv.ts`). Questions batch in one call at near-zero extra latency.

## Benchmark tiers

Cheapest first, same names as the bench code; aggregates only ([bench/README.md](bench/README.md)):

1. **Replay** (`bench/replay/`). Offline, over local sessions. Ground truth is lexical (what the model did next), which turned out to be the weak point; see Status (d). [RESULTS.md](bench/replay/RESULTS.md).
2. **Live** (`bench/live/`). Cold `pi -p` runs of a 30-prompt set against a fixed fixture repo. The fixture files are small, so triage rarely fires. [RESULTS.md](bench/live/RESULTS.md).
3. **SWE-bench Lite 20** (`bench/swe/`). Paired per-task runs through the moa-harness runner, arms `off`, `full`, `triage-vercel`, plus threshold arms `triage-vercel-010` / `-015`. [RESULTS.md](bench/swe/RESULTS.md).
4. **Session replay** (`bench/session-replay/`). Real long sessions judged by hosted Jev, context rebuilt offline, plus a threshold sweep and two harm proxies. [results](bench/session-replay/results-2026-09-23.md).

Rules: one pricing table and one telemetry version across arms. Tokens and call counts are ground truth; dollars are derived. `off` (full tool output) is the baseline; `mock` is a test-only judge, not an arm. Replay retries hosted-Jev 429/503 with backoff and trips a breaker; it never writes a fail-open answer as a result.

## Future ideas

Measured, then deferred: ship one strong capability first. `src/judge/types.ts` keeps the `choice` / `score` question shapes and the `prefix` / `spec` feature literals for them. The modules are in git history.

**Skip skill reads in triage.** Exclude reads under skill directories from triage: 4 of 10 recalls in the threshold arms were the model re-reading a skill file that triage had hidden.

**Prefix diet.** At `before_agent_start`, keep the top-5 skills plus a names-only index and the base tools plus the top-3, with a "none needed" gate. Live smoke: first turn 16,252 → 6,957 tokens (−57%). Replay, kev: tool recall@5 32%; "none" precision/recall kev 76% / 96%. Gotchas: never return `{ systemPrompt }` from `before_agent_start` (it becomes `forceSystemPrompt` and rewrites the prefix every turn; mutate `systemPromptOptions` in place). On `gpt-5.6-sol` any tool-set change resends the tool array and busts the cache from token 0, so select tools once per session, add-only.

**Spec routing.** The routing half of speculative read: after a search-like result, one `choice` over the listed paths or URLs plus `none`, and a gate `noul`, predict which file the agent reads next. Replay on 2,000 search → read pairs, kev: hit@1 39%, hit@2 52%; its gate said no on 40%.

**Speculative read.** Act on that route: append up to 2 chosen files to the same result, deleting the search → read turn (4.4% of calls, about 8 s each; also web_search → fetch_url). Live smoke on `gpt-5.6-sol`: prefetch appended, the model skipped the read turn and answered correctly. A latency play more than a cost play; every wrong pick is paid bytes.

## Files

- `extension/`: the Pi extension (triage, judge backends, telemetry). Run `pi -e pi-jev-tools/extension/src/index.ts`; `bun test` in `extension/`.
- `bench/replay/`: `bun run bench/replay/cli.ts <extract|judge|score|report> [--judge vercel|typesafe|local|mock] [--limit N] [--sample stratified] [--timeout-ms N] [--dry-run] [--yes]`. The deadline is `--timeout-ms`, else `PI_JEV_TIMEOUT_MS`, else 15000; `PI_JEV_BENCH_CONCURRENCY=1` against a single-threaded local sidecar. Cases and judged probabilities live under `~/.pi/agent/pi-jev/replay/` (verbatim session text, never in git).
- `bench/live/`: `bun bench/live/run.ts --arms off,triage-local,triage-vercel`, then `bun bench/live/score.ts --in <dir>`.
- `bench/swe/`: `arms.json` for the moa-harness runner.
- `bench/session-replay/`: `replay.ts`. The aggregate `results-*.md` is committed; per-result decisions (`*.jsonl`) and the session-label mapping (`private/`) stay local.
- `local-judge/`: loopback System One sidecar for `--judge local`. Default engine `kev` (`kev.serve` + `jaredpalmer/kev-0.8b`).
- `scripts/probe-window.ts`: Pi extension that dumps the first-turn system prompt, skills, and per-package tool schema sizes. `PI_JEV_PROBE_OUT=/tmp/probe pi -e scripts/probe-window.ts -p "reply with the single word ok"`.
- `scripts/mine-sessions.py`, `scripts/mine-sessions-cost.py`: mine `~/.pi/agent/sessions` for turn types, chains, context sizes, cost split, tool-result sizes.
