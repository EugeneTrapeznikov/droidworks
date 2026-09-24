# Projected triage savings on the real Pi corpus (2026-09-23)

**This is a projection, not a measurement.** It applies an assumed hide rate (10% / 16% / 25% of each eligible result's judged chars) to every eligible tool result in the corpus and replays each session's context to price the tokens that would not have been sent. No triage ran on these sessions. For comparison, the live bench (`bench/live/RESULTS.md`) measured 11% hidden (hosted Jev) and 1% (JevK5) on a small-file fixture; 16% is the SWE-bench Lite 20 figure.

Corpus: 1,080 top-level Pi sessions with ≥ 1 model call (`~/.pi/agent/sessions`, files > 50 KB), 96,218 model calls, 11.69 B context tokens (`input + cacheRead + cacheWrite`), $8,774 retail-equivalent (Pi's `usage.cost`; subscription, not billed). Eligible results: 30,914 (same gates as `mine-corpus-triage.py`, which also reports 30,914 on this run).

## Method

- **Re-sends.** Each eligible result is charged on every later model call whose context still holds it, starting with the first call after ingestion (triage replaces it before that call). The live set follows the session tree: `compaction` entries drop results before `firstKeptEntryId`; a branch switch rebuilds the set from the active path.
- **Pruning outside the transcript.** In 82 sessions, context drops without a compaction entry (extensions prune old results). Per call, the modeled eligible tokens are capped at `ctx − first call's ctx`; the oldest live results are evicted first. 3,162 of 30,914 results (10%) are evicted this way. Without the cap, eligible share of context is 70% and 5.3% of calls model more eligible tokens than the call's whole context.
- **Chars → tokens.** Each session's own ratio: Σ visible chars appended between consecutive calls ÷ Σ context growth, over gaps with no compaction or branch. 1,064 sessions use their own ratio (p10 / p50 / p90 = 2.70 / 3.30 / 3.82 chars/token); 16 fall back to 3.5 (ratio outside 1.5–8, or < 5k tokens of growth).
- **Input vs cacheRead.** Primary split uses each call's actual `input : cacheRead : cacheWrite` proportions. The positional variant prices a result at the call's input rate the first time it is sent and at the cacheRead rate afterwards. That matches prefix caching: an ingestion-time stub changes the cached prefix only once.
- **Rates.** Per call, `cost.<bucket> / usage.<bucket>`. For gpt-5.6-sol: input $5/M, cacheRead $0.50/M.
- **Overhead.** 155 tokens per call (the `<pi-jev>` system-prompt section plus the `pi_jev_recall` schema) and 30 tokens per stub (one ~110-char stub per eligible result, re-sent like the result). Both are subtracted from the net figures. Recall calls are not modeled.

## Aggregate

| Quantity | All sessions | > 20 calls |
|---|---:|---:|
| sessions / model calls | 1,080 / 96,218 | 721 / 92,455 |
| context tokens | 11.69 B | 11.58 B |
| eligible-result tokens, all re-sends (a) | 6.65 B (56.9% of context) | 6.61 B (57.1%) |
| … as input / cacheRead / cacheWrite (call proportions) | 0.56 B / 6.08 B / 0.005 B | 0.55 B / 6.05 B / 0.005 B |
| … sends that are re-sends, i.e. cached (positional) | 98.5% | 98.6% |
| eligible-result cost (call proportions) | $4,475 | $4,442 |
| sends per eligible result, mean (compounding factor) | 70.1 | 74.3 |
| sends per eligible result, p50 / p90 | 49 / 164 | 55 / 168 |
| overhead tokens (155/call + 30/stub-send) | 80.0 M | 79.0 M |

## Projected savings

Token % is of context tokens. Cost % is of total cost, output included. "Net" subtracts the overhead above. Per-session p50 / p90 and "> 5%" use net token %.

| Hide rate | Saved tokens (b) | Gross % | Net % | Saved cost, proportional (c) | Saved cost, positional | Net cost % (proportional) | Net cost % (positional) | Session p50 / p90 | Sessions > 5% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **All sessions** |||||||||
| 10% | 665 M | 5.7% | 5.0% | $447 | $347 | 4.5% | 3.4% | 4.1% / 6.4% | 35% |
| 16% | 1,063 M | 9.1% | 8.4% | $716 | $555 | 7.6% | 5.8% | 7.0% / 10.7% | 66% |
| 25% | 1,661 M | 14.2% | 13.5% | $1,119 | $868 | 12.2% | 9.3% | 11.4% / 17.3% | 79% |
| **> 20 calls** |||||||||
| 10% | 661 M | 5.7% | 5.0% | $444 | $344 | 4.6% | 3.4% | 4.9% / 6.6% | 47% |
| 16% | 1,057 M | 9.1% | 8.5% | $711 | $550 | 7.6% | 5.8% | 8.3% / 11.1% | 82% |
| 25% | 1,651 M | 14.3% | 13.6% | $1,110 | $859 | 12.2% | 9.3% | 13.4% / 17.8% | 92% |

Overhead cost is $49 (all sessions) and $48 (> 20 calls). Net positional cost = positional saved − overhead.

## Reading

- Tokens scale as hide rate × 57%, because eligible results fill most of the replayed context. SWE-bench Lite 20 is different: its context is mostly static prefix and tool output is ~4%, so the same 16% hide saved ~0%.
- Compounding is what makes the numbers large. An eligible result is sent a median of 49 times, and 98.5% of those sends are cache reads. Cost savings therefore run about 0.1× the token savings per re-send: 16% hide saves 9.1% of tokens but only 5.8% of cost (positional).
- The long tail carries all of it. Sessions with > 20 calls hold 99% of context tokens. Short sessions (≤ 20 calls) mostly land under 5%, because the 155-token prefix overhead is a larger share there.

## Caveats

- **Projection from an assumed hide rate.** Real hide rates vary by tool and content. The live fixture measured 1% (local) and 11% (hosted). A hidden block that the model needs costs a `pi_jev_recall` call plus the re-sent recalled text. That is not modeled (live: 0.03 recalls/run).
- **Pruning is inferred.** Compaction (174 entries) is replayed exactly. Pruning with no transcript entry is approximated oldest-first, so the true re-send counts for those 82 sessions are uncertain. Without the cap, gross savings at 16% would be 11.2% of tokens.
- **Changed behavior is not modeled.** Stubs could change what the model does next (more reads, fewer calls). Hiding also shifts when compaction triggers, which would lower its frequency.
- **Chars/token.** The session ratio mixes prose and code. At a flat 3.5 chars/token, token savings drop about 6%.
- **cacheRead pricing.** Proportional pricing charges each re-send at the call's blended rate, which overstates cost savings, because re-sends are almost all cached. Treat positional as the better cost estimate. Rates are Pi's retail-equivalent estimates; the sessions ran on a subscription.
- **State cap.** Hide is applied to all eligible chars. Under the 24k local cap, 16.7% of eligible chars go unjudged; under the 80k hosted cap, 0.5% (`corpus-2026-09-23.md`).

## Command

```bash
cd pi-jev-tools
python3 scripts/project-triage-savings.py > projected.json   # every number above; ~10 s, read-only, stdlib
python3 scripts/mine-corpus-triage.py | python3 -c "import json,sys; print(json.load(sys.stdin)['eligible_results'])"   # cross-check: 30914
```
