# Jev facts, prior art, and benchmark landscape

Web research dated 2026-09-22. Primary sources only; vendor numbers marked as such.

## Jev / TypeSafe

Launched 2026-09-15. Model `jev-1.13.0` (aliases `jev-latest`, `jev-preview`). Endpoint `POST https://api.typesafe.ai/v1/systemone`, Bearer auth. Closed weights, hosted, waitlisted.

| Spec | Value (docs.typesafe.ai) |
|---|---|
| Question types | Choice (up to 255 options), Score (2–10 ordered levels), Noul (yes/no) |
| Context | 64k tokens per request; 32k for `state` plus the longest question |
| Input | text only: string, JSON object, or array |
| Batching | first-class; questions in one call evaluate independently in parallel, "adding questions barely changes the response time" |
| Latency | vendor 70–500 ms; independent p50 378–422 ms, floor ~430 ms |
| Pricing | $0.042 per M input tokens, output free |
| Rate limits | 250k tokens/s, 1,200 requests/min |
| SDKs | Python, JS/TS (`@typesafe-ai/sdk`, Node 20+), raw HTTP |

Response: `answers` per question, full `probabilities` summing to 1, derived `confidence` (for 3 options `(3·pmax − 1)/2`). Docs suggest >0.9 auto-act, 0.5–0.9 confirm, <0.5 human.

Documented weaknesses (`docs.typesafe.ai/model-jaggedness/jev-1.13`): degrades on large irrelevant state; no guarantee `P(q) = 1 − P(¬q)`; poor at indirection and double negatives; vulnerable to injected content.

### Vercel AI Gateway route

Jev is listed: `GET https://ai-gateway.vercel.sh/v1/models` returns `typesafe-ai/jev`, `type: "evaluation"`, context 32000, pricing input 0.000000042 / output 0, ZDR and no-training flags. It is not OpenAI-chat compatible. Call it with AI SDK `experimental_evaluate` (AI SDK ≥ 7.0.105) using the same `state` + `questions` shape; the gateway names yes/no `boolean` instead of `noul`; confidence is at `result.providerMetadata.typesafe.confidence`. Card on file required (`customer_verification_required` otherwise). `Experimental_EvaluationMockModelV4` from `ai/test` mocks it offline. Also on OpenRouter as `typesafe/jev-1.13`. Consequence: no LiteLLM-style OpenAI shim for Jev; the gateway is still useful as the one endpoint for a cheap chat-model fallback ranker.

### TypeSafe's own evals (self-reported)

- Skill suggestion cookbook, the exact use case: 182 skills, 488 requests (315 covered, 173 uncovered). Two stages: Choice over all 182 plus three Nouls "is a skill needed at all" (mean < 0.30 means suggest nothing), then re-rank top 3 with full descriptions. Wrong loads 16.8% → 7.3% (oracle 2.5%); needless loads 9.8% → 4.0% (oracle 1.2%).
- Re-ranking (CLERC legal): BM25 top-1 5% → 18%, top-10 38% → 62%; 1,200 pairs, 1.5M input tokens, about $0.06.
- Parallel questions: 13 questions batched vs serial, 12.2× cheaper, 10× faster, identical answers.

### Independent evals

| Source | Finding |
|---|---|
| PriorBench (MIT, 5,721 calls) | 95.9% zero-shot on a 400-item set vs 77.2% keywords. Always answers: 0/30 out-of-scope inputs flagged, random letters classified at 0.97 confidence. |
| jev-benchmark (60 tool-risk cases) | 91.7% overall; ECE 0.05–0.07; every wrong answer came with hedged confidence. p50 421 ms. |
| jev-harness-lab (22,500 calls, $2.19) | Tool catalog routing 96.5% (199 tools, k=5). BFCL tool relevance 77.0%. Skill routing R@1 9.0% → 81.0% by switching from single Choice to Choice plus Noul verification. Failed: predicting other models' difficulty (51%), trajectory failure attribution (AUROC 0.56). |
| jev-decision-benchmarks | BFCL V4 86.74% irrelevance / 87.50% relevance. MetaTool abstain 87.04%. When2Call 74.84% acc / 56.55 macro-F1. |

Design consequence: "none needed" must be an explicit Choice option or a separate Noul gate. It cannot be inferred from low confidence, because Jev is calibrated within the option set, not over whether the question makes sense.

## Prior art that already does this

| Repo | What | Take |
|---|---|---|
| y0usaf/pi-jev (MIT) | Pi extension: tool-call gate on bash/write/edit, output judge, `jev_ask` tool. ~300 ms per batched 4-question gate; output judge 126 ms median, 490 tokens/request. Shadow mode default. Threshold lesson: an ordinary edit scores up to 0.85 on "destructive", so they gate at 0.90. | Fork the hook plumbing and shadow mode. |
| shimo4228/jev-skill-router (MIT) | Claude Code UserPromptSubmit skill router, Choice plus Noul gates. Authors' conclusion: "as a router it is unlikely to help a strong model in Claude Code" because the host already sees full descriptions. Weak on follow-up prompts (fit 0.34–0.64). | Negative result. Our advantage over it is only the token cut, not accuracy, unless the catalog exceeds 30–50 entries. |
| GhalebDweikat/winnow (MIT) | Claude Code only: a TypeScript function hook (`hooks/winnow.ts`, needs Claude Code 2.1.260+ with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) plus a Python sidecar on loopback. Splits each tool result into ~25-line blocks, one batched Noul per block "is this block needed for the current task" (task = last assistant message truncated to its final 1,500 chars, plus the first 1,500 chars of the user request). Drop below p 0.1, keep verbatim above 0.5, uncertain stays. Error gate: kept only when the judge's error question scores ≥0.5. Skip unless ≥20% would be hidden. Dropped blocks become a 3-line stub with line range, summary, and a `winnow_recall` key; full text cached in `~/.winnow/cache`. 16 ms/call via sidecar vs 381 ms cold. ~$0.0004/call Jev vs ~$0.01 Haiku. `winnow replay` reads `~/.claude/projects/*/session.jsonl`, weak-labels a block "needed" if lines were later reused in edits or identifiers mentioned, then scores regret and calibration; 300 cases, 97 hand labels, hides ~5% of text at drop 0.1. | Not usable in Pi as-is. Port the judge design (block split, thresholds, stubs + recall tool, error gate, min-prune ratio) into a Pi `tool_result` hook, and port `replay` to Pi JSONL. |
| ilkerulusoy/pi-jev-compact (MIT, 8 commits, 85 tests) | Pi extension, manual `/jev-compact` only. Scores each past tool call twice (call matters? result should remain?), threshold 0.5 (0.3 for prose). Writes a new pruned session file; dropped results are gone. Synthetic data: 15.5% recovered tool-only, 33.5% with prose. Decision quality unmeasured. | Retroactive eviction, not ingestion. |
| joelhooks/pi-fast-jev-compaction (MIT, 8 commits, Vitest) | Pi extension for 0.85.1. Rebuilds a decision ledger on startup/resume/fork; on `turn_end` at 60% context it asks two Nouls per eligible tool call and applies keep / drop_result (keeps a ~300-char head) / drop_call, keepThreshold 0.5, last 6 messages pinned. Filters the context only; session JSONL untouched. Tracks cacheRead/cacheWrite per run. Falls back to Pi's own compaction if reduction < 25% or on error. | Closest existing thing to our eviction step; evaluate before writing our own. |
| jev-codex-router, Jevonian | per-turn model + thinking routing; savings are backtests from price tables, not invoices. | Routing evidence is weak. |
| pi-jev-compact, pi-fast-jev-compaction | Pi context pruning with Jev. | Overlaps triage; read before building. |
| LiteLLM | ships Jev complexity routing and a relevance guardrail for compacting tool results. | |

Anthropic Tool Search Tool (Nov 2025, vendor-reported): 85% token reduction (~77k → ~8.7k before work begins), Opus 4 49% → 74%, Opus 4.5 79.5% → 88.1% on internal MCP evals. Deferred tools are excluded from the cached prefix. Their docs: tool choice degrades past 30–50 available tools. Claude Code auto-defers when MCP descriptions exceed 10% of context.

## The cautionary result

JetBrains replicated RTK (marketed 60–90% token reduction) on SkillsBench: 86 tasks, 425 billed trials, paired Wilcoxon. Low effort: median +7.6% more expensive per task (p=0.004); +13.8% more turns (p=0.03); +14.3% more cache reads (p=0.008); quality unchanged. Cause: the hook only sees about a fifth of the tool output, and cache invalidation plus extra turns ate the gain. Anthropic's own context-editing docs say clearing invalidates the cached prefix and bills a cache write. Rule: measure billed tokens and turn count, never filter ratio.

Speculative execution literature buys latency with tokens: Speculative Actions −20% latency; PASTE −48.5% completion time at 27.8% top-1 accuracy; toolspec −11.5% latency, +15.3% wasted tool-seconds. Frame speculative reads as a latency play unless the speculation rides in the same Jev batch.

## Benchmarks to run

### Selection quality, offline, no Docker (~2 h)

1. BFCL v4 splits `irrelevance` + `live_irrelevance` + `live_relevance` + `live_multiple` (~2,200 rows), `pip install bfcl-eval==2025.12.17`. Pure AST/string matching. Public Jev reference 86.74% / 87.50%. Epoch AI found defects in 24/50 audited tasks (e.g. `irrelevance_228`), so hand-clean and trust deltas, not absolutes.
2. When2Call (NVIDIA, Apache-2.0): four-way `direct` / `tool_call` / `request_for_info` / `cannot_answer`, MCQ via lm-eval-harness, reports tool hallucination rate.
3. Copy ToolMenuBench's metrics: gold next-tool exposure, extra tools exposed, risky-tool exposure, plus token usage; sweep catalog size 25/100/250. Its prior: all-tools 32.1% success / 56,062 tokens vs best filter 85.7% / 1,125 tokens.

### Agent efficiency with paired per-task data (~4 h, $30–60/arm)

- mini-SWE-agent on HAL's SWE-bench Verified Mini (50 ids). Only setup publishing `api_calls` per instance across ~40 baselines; ships `per_instance_details.json` with `{cost, api_calls, resolved}`. Run 2–3 repeats per arm, since per-task tokens vary up to 30× between runs. Published table: Opus 4.5 76.8% at 32.9 calls/inst, GPT-5 medium 65.0% at 13.2, Haiku 4.5 66.6% at 66.2.
- Upgrade: Claw-SWE-Bench lite (80 instances): Pass@1, billing-log USD, in/out/cache tokens, cache-hit rate, mean wall clock, average turns; confounds pre-pinned.
- Pin one pricing table and one telemetry version across arms; the same usage was priced $1,786 vs $9,913 across litellm versions in one audit.

DeepSWE datum for the pitch: three models tie at 74% Pass@1 with a 5× cost and 5.7× step spread (astra 29 steps $4.43, gemini-3.8-flash 166 steps $2.36, opus-5 99 steps $11.84).

Wrong shape for iterating a pre-filter: MCP-Bench, MCP-Universe, MCPMark, LiveMCPBench, StableToolBench (full agent loops, live credentials, no "no tool applies" class).

## Sources

TypeSafe: https://docs.typesafe.ai/models · https://docs.typesafe.ai/api · https://docs.typesafe.ai/cookbooks/skill_suggestion · https://docs.typesafe.ai/cookbooks/parallel_questions · https://docs.typesafe.ai/model-jaggedness/jev-1.13 · https://docs.typesafe.ai/patterns/fan-out
Vercel: https://vercel.com/ai-gateway/models/jev · https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk · https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
Independent evals: https://github.com/priorbench/jev · https://github.com/themsquared/jev-benchmark · https://dev.to/aitejiu/benchmarking-jev-what-a-decision-model-can-and-cant-do-in-an-agent-harness-20po · https://github.com/baibizhe/jev-decision-benchmarks
Prior art: https://github.com/y0usaf/pi-jev · https://github.com/shimo4228/jev-skill-router · https://github.com/GhalebDweikat/winnow · https://github.com/ilkerulusoy/pi-jev-compact · https://github.com/joelhooks/pi-fast-jev-compaction
Anthropic: https://www.anthropic.com/engineering/advanced-tool-use · https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool · https://platform.claude.com/docs/en/build-with-claude/context-editing
Cautionary: https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/ · https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/ · https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review · https://github.com/amnry/swe-bench-token-waste
Benchmarks: https://gorilla.cs.berkeley.edu/leaderboard.html · https://github.com/NVIDIA/When2Call · https://arxiv.org/abs/2606.15508 · https://github.com/SWE-agent/mini-swe-agent · https://www.swebench.com/ · https://arxiv.org/html/2606.12344v1 · https://deepswe.datacurve.ai/ · https://hal.cs.princeton.edu/ · https://arxiv.org/abs/2509.09853
Speculation/routing: https://arxiv.org/abs/2510.04371 · https://arxiv.org/html/2603.18897v1 · https://arxiv.org/abs/2605.18796 · https://arxiv.org/pdf/2403.12031 · https://arxiv.org/abs/2510.00202
