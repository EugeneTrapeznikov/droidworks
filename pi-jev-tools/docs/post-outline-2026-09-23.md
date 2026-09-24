# Post outline: tool-result triage for Pi with Jev (2026-09-23)

Skeleton only. Every number comes from the files under `bench/`; aggregates only.

## Title options

- We freed 3–6% of context with Jev, and that was the honest win
- A 65-cent judge freed 3% of every call's context: tool-result triage with Jev
- Hiding dead tool output with a decision model: small, measured, safe

## Hook

- Winnow ported to Pi: split each big tool result into blocks, ask Jev "is this block needed?" for each one, and hide the dead runs behind a stub the model can recall.
- The day we measured it, hosted Jev answered 429 and 503 all day (1,710 × 429 and 2,704 × 503 retries in one run). Fail-open mattered on day one.

## What we built

- One `tool_result` hook that rewrites at ingestion. Earlier messages and the cached prefix are never touched.
- Blocks are ≤ 25 lines and ≤ 1,500 chars. One `noul` per block plus a model-answered error question. The first and last block are always kept.
- Hide at P ≤ 0.10, keep at P ≥ 0.5, skip the rewrite when under 20% would be hidden. On a 15 s timeout or error, fail open. `pi_jev_recall` restores any hidden run.
- Diffs and JSON pass through unjudged. Only the leading run of blocks under the per-backend state cap is judged.

## Method: three tiers, and why tier 1 failed

- Corpus first: tool results are 95% of transcript chars, and 81.5% of tool-result chars are eligible for triage.
- Tier 1, offline replay with weak labels. A block counts as "needed" if a later edit reuses a line, a later read names a path, or the answer quotes an identifier.
- Why it failed: the labels are lexical echo. A token-overlap baseline wins by copying the labeler, while both real judges sat at chance (AUC 0.478 hosted, 0.510 JevK5, n = 97).
- Tier 2 live (30 prompts, small fixture: triage rarely fires) → tier 3 SWE-bench Lite 20 for safety → session replay on real long sessions for context.

## Safety: SWE-bench Lite 20

- Resolved: `full` 9/20, `off` 9/20, triage 10/20. Tokens and cost vs `full` within noise; +11 s per task.
- 16% of tool-result chars hidden per task (p50), 5 recalls, 20% of judge calls failed open (23/116).

## Context: session replay on 20 long sessions

- At 0.10: 10.2% of judged chars hidden, 3.1% of context freed per call (session p50), $0.65 of Jev spend.
- Threshold sweep 0.10 → 0.30: context saved 3.3% → 14.5% (aggregate). Loose flagged 38.6% → 57.9%, strict unique loss 4.3% → 8.2%.
- Define the two proxies. Flagged: an identifier from the hidden block comes back later. Unique loss: that identifier was visible nowhere else when it came back.
- 75% of judged results were kept whole under the 20% prune ratio. The drop threshold is the lever, not the ratio: hosted Jev's block P median is 0.20, and only 11% of blocks are ≤ 0.10.
- Tier 3 at drop 0.15: 10/20 resolved, same as 0.10, with 19% vs 8% of tool-result chars hidden per task (p50) and 6 vs 4 recalls. 4 of 10 recalls re-read a hidden skill file.

## Surprise: full Pi vs bare Pi

- Same 9/20 at 3.2× tokens and 1.9× cost. That is the skills and extensions prefix re-read every turn, not extra work.

## What we dropped and why

- kev-0.8b: AUC 0.509, hid 0.1%.
- JevK5: never scored a block below 0.1 (min 0.107), and timed out at 15 s on large reads.

## Lessons

- Tune the threshold per corpus. 0.10 came from winnow on another host, and on these sessions it leaves most results whole.
- Cached tokens are cheap (~0.1× input), so context headroom is the real benefit: $61 of $1,756 input+cacheRead (3.5%), retail-equivalent, on a subscription.
- Label your ground truth carefully. Lexical labels reward lexical rankers.
- Fail-open plus recall makes a wrong hide cheap: the worst case is one recall call, or the full result.

## Compared with pi-fast-jev-compaction

- That extension works at compaction time. At 60% context it drops results or calls from the context (the last 6 messages pinned) and falls back to Pi's compaction when the reduction is under 25%.
- Ours works at ingestion time and leaves stubs. The cached prefix changes only once per result and earlier messages are never rewritten.
- The two are complementary: triage shrinks what enters the context, and compaction evicts what went stale.

## Figures

- `bench/figures/corpus-tool-output-2026-09-23.html` and `corpus-2026-09-23.md`: tool output share, eligibility by tool and by size.
- `bench/figures/session-replay-probs-2026-09-23.md`: Jev block P histogram and the threshold what-if.
- `bench/figures/projected-savings-2026-09-23.md`: projection at assumed hide rates (not a measurement).
- `bench/session-replay/results-2026-09-23.md`: per-session table and the threshold sweep.
