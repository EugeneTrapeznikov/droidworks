# Pi JEV Tools

Tool-result triage for Pi, driven by a decision model. One capability: a large tool result is split into blocks, a Jev-style judge answers "is this block needed?" per block, and dead runs are hidden behind a stub the model can restore with `pi_jev_recall`. It is a port of [winnow](https://github.com/GhalebDweikat/winnow) onto Pi's `tool_result` event.

Status: the extension ships triage only ([extension/README.md](extension/README.md)). The comparison on every tier is **off (full tool output) vs triage with JevK5 vs triage with Jev**. Replay kev numbers are being rerun with the `winnow` question set, full-text blocks under the state cap, and `tool` in the judge state. Live and SWE-bench Lite 20 triage arms are next. Other ideas are deferred until triage is strong; see [Future ideas](#future-ideas).

## What "Jev" is

Not an acronym. Jev is TypeSafe's "System One" decision model: a fast, cheap non-LLM that only picks from a finite option set and returns per-option probabilities. BuilderIO/agent-native calls it once per user prompt to choose which tool schemas and skill bodies enter the model's context. The ranker is the replaceable part; the placement is the idea. Details: [research/video-fake-jev-demos.md](research/video-fake-jev-demos.md), [research/agent-native-implementation.md](research/agent-native-implementation.md).

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

One `tool_result` hook (`extension/src/triage/`), rewriting at ingestion, before the result is ever sent, so earlier messages and the cached prefix are never touched.

1. Skip unless the tool is allowlisted (`read,bash,grep,find,ls,fetch_url,mcp*`) and the result is ≥ 2,000 chars.
2. Split into blocks of ≤ 25 lines and ≤ 1,500 chars; a longer single line is hard-split into ≤ 1,500-char pieces (stubs and recall still address the whole line).
3. One judge call: a `noul` per block plus the ERROR question, which the judge answers (P ≥ 0.5 keeps the whole result; no regex), question wording from `PI_JEV_QUESTION_SET` (`winnow` default). State is `{ task, tool, blocks }`, capped per backend (`PI_JEV_STATE_CHARS`): only the leading run of full blocks that fits is judged, the rest stay visible.
4. `decide()`: head and tail pinned; hide at P ≤ 0.1, keep at P ≥ 0.5; skip the rewrite if under 20% would be hidden or the error gate fires.
5. Hidden runs become `[pi-jev: hid lines …]` stubs; originals are cached for `pi_jev_recall`.

Fail-open: a judge timeout or error leaves the result untouched. `PI_JEV_SHADOW=1` (default) decides and logs without mutating. Every decision is a `DecisionRecord` in `PI_JEV_LOG`.

## Jev access

Jev is on Vercel AI Gateway as `typesafe-ai/jev` (`type: "evaluation"`, $0.042/M input, output free). It is not OpenAI-chat compatible, so it cannot go through a LiteLLM shim; the extension calls `POST https://ai-gateway.vercel.sh/v1/evaluate` with plain fetch. Key lives in `~/.config/vercel/.env` as `VERCEL_API_KEY`; the extension loads it at runtime (`extension/src/judge/dotenv.ts`). Questions batch in one call at near-zero extra latency. Details and prior art: [research/benchmarks-and-prior-art.md](research/benchmarks-and-prior-art.md).

## Benchmark tiers

Three tiers, cheapest first, same names as the bench code:

1. **Replay** (`bench/replay/`). Offline replay of ~1,077 local sessions, no model cost. Ground truth is what the model did next: a block is needed if a later edit reuses one of its lines, a later read opens a path it names, or the final answer quotes an identifier from it. Metrics: AUC, recall of needed blocks vs bytes hidden, both as a raw threshold sweep and through the shipped `decide()`. [RESULTS.md](bench/replay/RESULTS.md).
2. **Live** (`bench/live/`). Cold `pi -p` runs of a 30-prompt set from a fixed fixture repo, arms `off` and `triage-{local,vercel}`. Metrics: first-turn prefix (`input + cacheRead`), calls, cost, bytes hidden, `pi_jev_recall` turns. [RESULTS.md](bench/live/RESULTS.md).
3. **SWE-bench Lite 20** (`bench/swe/`). Paired per-task coding-agent efficiency through moa-harness `bench/run.py --host pi`, arms `off`, `full`, `triage-{local,vercel}`. Hypothesis: calls and billed tokens drop, resolve rate holds within noise. [README](bench/swe/README.md).

Rules: one pricing table and one telemetry version across arms; tokens and call counts are ground truth, dollars derived.

### Measurement plan

- **Hosted Jev (`vercel`).** On 2026-09-23 the gateway shed load with HTTP 429 ("upstream provider is currently experiencing high demand"); live runs that failed open that day were quarantined and rerun. Replay now retries with exponential backoff (30 s start, 5 min cap) and trips a breaker (exit 3) under 50% success over 50 attempts, and never writes a fail-open answer.
- **Local judges (`local`).** kev-0.8b (`local-judge/server.py --engine kev`, port 47411) on the laptop, and JevK5 v0.2.0 (`jevk5-serve` behind the sidecar, port 47412) on a remote GPU box. Both run at a 24000-char state cap; name each in `settings.json` `"pi-jev".judges` ([extension/README.md](extension/README.md#configuration)). Both answer the same wire contract; see [local-judge/README.md](local-judge/README.md).
- `off` (full tool output) is the baseline; `mock` is a test-only judge, not an arm.

## Future ideas

Measured, then deferred: ship one strong capability first. `src/judge/types.ts` keeps the `choice` / `score` question shapes and the `prefix` / `spec` feature literals for them. The modules are in git history.

**Prefix diet.** At `before_agent_start`, keep the top-5 skills plus a names-only index and the base tools plus the top-3, with a "none needed" gate. Live smoke: first turn 16,252 → 6,957 tokens (−57%). Replay, kev: tool recall@5 32%; "none" precision/recall kev 76% / 96%. Gotchas: never return `{ systemPrompt }` from `before_agent_start` (it becomes `forceSystemPrompt` and rewrites the prefix every turn; mutate `systemPromptOptions` in place). On `gpt-5.6-sol` any tool-set change resends the tool array and busts the cache from token 0, so select tools once per session, add-only.

**Spec routing.** The routing half of speculative read: after a search-like result, one `choice` over the listed paths or URLs plus `none`, and a gate `noul`, predict which file the agent reads next. Replay on 2,000 search → read pairs, kev: hit@1 39%, hit@2 52%; its gate said no on 40%.

**Speculative read.** Act on that route: append up to 2 chosen files to the same result, deleting the search → read turn (4.4% of calls, about 8 s each; also web_search → fetch_url). Live smoke on `gpt-5.6-sol`: prefetch appended, the model skipped the read turn and answered correctly. A latency play more than a cost play; every wrong pick is paid bytes.

## Files

- `extension/`: the Pi extension (triage, judge backends, telemetry). Run `pi -e pi-jev-tools/extension/src/index.ts`; `bun test` in `extension/`.
- `bench/replay/`: `bun run bench/replay/cli.ts <extract|judge|score|report> [--judge vercel|typesafe|local|mock] [--limit N] [--sample stratified] [--timeout-ms N] [--dry-run] [--yes]`. The deadline is `--timeout-ms`, else `PI_JEV_TIMEOUT_MS`, else 15000; `PI_JEV_BENCH_CONCURRENCY=1` against a single-threaded local sidecar. Cases and judged probabilities live under `~/.pi/agent/pi-jev/replay/` (verbatim session text, never in git).
- `bench/live/`: `bun bench/live/run.ts --arms off,triage-local,triage-vercel`, then `bun bench/live/score.ts --in <dir>`.
- `bench/swe/`: `arms.json` for the moa-harness runner.
- `local-judge/`: loopback System One sidecar for `--judge local`. Default engine `kev` (`kev.serve` + `jaredpalmer/kev-0.8b`).
- `scripts/probe-window.ts`: Pi extension that dumps the first-turn system prompt, skills, and per-package tool schema sizes. `PI_JEV_PROBE_OUT=/tmp/probe pi -e scripts/probe-window.ts -p "reply with the single word ok"`.
- `scripts/mine-sessions.py`, `scripts/mine-sessions-cost.py`: mine `~/.pi/agent/sessions` for turn types, chains, context sizes, cost split, tool-result sizes.
- `research/`: video analysis, agent-native code walkthrough, Pi API feasibility with calibrated numbers, benchmark landscape and prior art.
