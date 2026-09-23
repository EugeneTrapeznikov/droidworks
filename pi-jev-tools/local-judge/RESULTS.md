# Local System One sidecar — candidates and measurements

Measured 2026-09-23 on an Apple M5 Max, 36 GB, macOS 25.6. Every number in the
"measured" tables came off this machine; everything in the candidate table is
the project's own claim unless marked.

## 1. Candidates (web research, 2026-09-23)

`awesome-open-system-one` exists ([rupeshpoojary9](https://github.com/rupeshpoojary9/awesome-open-system-one),
mirrored by MorrisZJ; sibling list [cobanov/awesome-jev](https://github.com/cobanov/awesome-jev)).
Both are thin curator repos — their presence on the list is not evidence of quality.

### Purpose-built System One clones

| Project | Params | License | Apple Silicon | Claimed accuracy (self-reported) | Verdict |
|---|---|---|---|---|---|
| **[jaredpalmer/kev](https://github.com/jaredpalmer/kev)** — Kev-0.8B / 4B / 9B on Qwen3.5 bases | 0.8B / 4B / 9B | Apache-2.0 | **yes, MLX first-class**; README publishes M5 latencies and MLX-vs-fp32 parity | 4B 0.797/0.837 new-source, Brier 0.255; 9B 0.822/0.852; Jev 0.857. Ships a fitted temperature (2.1–2.4); ECE 0.106 → 0.042 | **chosen.** Serves `POST /v1/systemone` itself. 4.8k stars, pushed today |
| [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya) (+ [laya-mlx](https://github.com/mizorewww/laya-mlx)) | 421M (ModernBERT-large + decision head) | Apache-2.0 | yes via third-party `laya-mlx`, ~13.4 ms/question claimed | 0.766 vs Jev 0.727, ECE 0.081, benchmark unnamed | untested here. Smallest credible option; the MLX port is third-party and its 5.6k-star count is implausible for a satellite repo |
| [wfzyx/von](https://github.com/wfzyx/von) | 395M (ModernBERT-large) | Apache-2.0 | PyTorch/MPS only; third-party MLX port | 72.0% macro on a 49-task "jabr v2" set; ViZDoom kill-count comparisons | skipped. The same description is copy-pasted across ≥5 accounts; canonical repo ambiguous; `von-sdk` 1.0.1 wheel reportedly omits `von/models/` |
| [TianyuCodings/NanoJev](https://github.com/TianyuCodings/NanoJev) | Qwen3-0.6B backbone | MIT | not stated | only toy-game results (ViZDoom, maze, snake) | educational, not a judge |
| [iapp/OpenThai-SystemOne](https://huggingface.co/iapp/OpenThai-SystemOne) | 0.8B | Apache-2.0 | no GGUF/MLX; `transformers` + `trust_remote_code` only | macro 74.3%; Thai-first, admits weaker English yes/no | wrong language target |
| [nokia-applied-research/AnyJev](https://github.com/nokia-applied-research/AnyJev) | wrapper, no weights | Apache-2.0 | no; `transformers`/vLLM logprobs | n/a — it is the method, not a model | **this is what `--engine logprob` reimplements.** Adds cyclic-shift marginalisation + label-free prior correction; our contextual calibration is the cheap version of the same idea. Org's Nokia affiliation unverified |

**"kev" is real and is the answer to what the user saw.** `jaredpalmer/kev`,
Apache-2.0, Qwen3.5-based, 4.8k stars, #1 on Hacker News around 2026-09-17,
API-compatible with TypeSafe's System One so the official SDK works with a
`base_url` swap. No other project by that name exists in this space.

### Generic small instruct models (the AnyJev / logprob route)

All `mlx-community` 4-bit, Apache-2.0 except where noted, loaded by `mlx-lm` 0.31.3.
Qwen3-1.7B (0.98 GB on disk) and Qwen3-4B (2.28 GB) were measured; Gemma-3-1B
(Gemma licence), Llama-3.2-3B (Llama licence) and SmolLM3-3B were not — Qwen3
won on the first two so the rest were not worth the download. Qwen3.5 is
multimodal and loads through `mlx-vlm`, not `mlx-lm`, so it is a worse fit for a
single-prefill text classifier despite being newer.

### Cross-encoder rerankers as a choice backend

`BAAI/bge-reranker-v2-m3` (568M, Apache-2.0) was measured. `mxbai-rerank-*-v2`
and `Qwen3-Reranker-0.6B` were not: the bge result (below) was bad enough to
close the line of inquiry. No MLX port exists for any of the three; all run on
PyTorch MPS through `sentence-transformers`.

## 2. The local set

60 items, built by `eval.py` and written to `eval.jsonl`:

- **15 tool-routing choices** over the user's 18 active Pi tools (`research/pi-feasibility.md` A.2) plus a `none` option.
- **15 skill-routing choices** over the 33 skills resolved from `~/.pi/agent/settings.json` plus `none`. Gold is a *set* where the catalog contains near-duplicates (`grilling`/`grill-me`/`grill-with-docs`, `handoff`/`handoff-doc`).
- **10 "none needed"** plain prompts ("hi", "what's 17 * 23?") against the same two catalogs; gold is `none`.
- **20 block-relevance nouls**: `scripts/mine-sessions.py`, `scripts/mine-sessions-cost.py` and `scripts/probe-window.ts` cut into 25-line blocks, paired with two hand-written tasks and hand-labelled. Base rate 6 yes / 14 no.

ECE is 10-bin over the confidence assigned to the predicted label.
Latency is one question per request, warm; `p50` excludes the first request.

## 3. Measured

| Engine | Model | acc | ECE | mean conf | p50 ms | p95 ms | RSS |
|---|---|---:|---:|---:|---:|---:|---:|
| **kev, `KEV_TEMPERATURE=1.3`** | **kev-0.8b (MLX, bf16)** | **0.750** | **0.137** | 0.69 | **39** | 103 | 3.6 GB |
| kev, shipped T=2.41 | kev-0.8b | 0.750 | 0.264 | 0.49 | 32 | 71 | 3.6 GB |
| logprob, raw, temp 6 | Qwen3-4B-4bit | 0.733 | 0.122 | 0.70 | ~150 | ~400 | 2.9 GB |
| logprob, raw, temp 1 | Qwen3-4B-4bit | 0.733 | 0.276 | 0.99 | 175 | 402 | 2.9 GB |
| logprob, calibrated | Qwen3-4B-4bit | 0.550 | 0.322 | 0.87 | 164 | 693 | 2.9 GB |
| logprob, calibrated, temp 3 | Qwen3-1.7B-4bit | 0.683 | 0.150 | 0.61 | ~73 | ~206 | 1.6 GB |
| logprob, calibrated, temp 1 | Qwen3-1.7B-4bit | 0.683 | 0.172 | 0.84 | 73 | 206 | 1.6 GB |
| logprob, raw | Qwen3-1.7B-4bit | 0.600 | 0.355 | 0.96 | 89 | 264 | 1.7 GB |
| reranker | bge-reranker-v2-m3 | 0.467 | 0.414 | 0.20 | 76 | 278 | 2.9 GB |

Per group (temperature never changes the argmax, so these hold across the
temperature rows):

| Engine | tool (15) | skill (15) | none (10) | block (20) |
|---|---:|---:|---:|---:|
| kev-0.8b | 0.667 | 0.667 | **1.000** | **0.750** |
| Qwen3-4B raw | 0.733 | **0.867** | 0.600 | 0.700 |
| Qwen3-1.7B calibrated | **0.800** | 0.733 | 0.600 | 0.600 |
| Qwen3-1.7B raw | 0.733 | 0.533 | 0.300 | 0.700 |
| bge-reranker-v2-m3 | 0.200 | 0.667 | 0.900 | 0.300 |

Cold vs warm: model load 1.0–4.8 s for MLX `logprob`, 27 s for the reranker
(torch import dominates), ~40 s for a `kev.serve` start. First request after
load is 40–390 ms; thereafter the numbers above. Total model weights pulled for
this work: **~7.4 GB** (Qwen3-1.7B 0.98, Qwen3-4B 2.28, Qwen3.5-0.8B-Base 1.77,
kev adapter 0.07, bge-reranker 2.30).

## 4. What the numbers say

**The phrasing of a noul matters more than the model.** "Is this code block
needed to carry out the current task?" scores **0.30** on kev-0.8b — it answers
yes to everything, including blocks from an unrelated file. Adding one clause,
"Answer no if it is from an unrelated file or an unrelated part of the code",
takes the same model on the same 20 items to **0.75**. Inverting the question
("can this be hidden?") scores 0.25. All four engines failed identically on the
bare phrasing, so this is a prompt property, not a model property. The eval set
uses the sharpened phrasing; both numbers are reported here so the gain is not
mistaken for model quality.

**Contextual calibration helps the 1.7B and hurts the 4B.** Subtracting the
label distribution the template produces on a content-free `"N/A"` state
(Zhao et al. 2021) takes Qwen3-1.7B from 0.600/ECE 0.355 to 0.683/ECE 0.172,
mostly by fixing its refusal to ever answer `none` (0.300 → 0.600). The same
transform takes Qwen3-4B from 0.733 to 0.550, wrecking `none` (0.600 → 0.100):
the 4B already has a usable prior and the correction overshoots. Hence
`--no-calibrate` in the recommended Qwen3-4B config. The prior is cached per
question template, so it is free when the template repeats — but a triage batch
that embeds a different code block in every question's `instructions` misses
the cache and pays a second prefill per question (10-noul batch: 1.6 s → 3.5 s).
**Put what varies in `state`, not in `instructions`.**

**Raw logprobs from an instruct model are unusable as probabilities.**
Qwen3-4B's mean confidence is 0.985 against an accuracy of 0.733, with typical
label log-prob gaps of 18 nats. Temperature 6 is needed to move ECE (0.276 →
0.122); temperatures 1.5–3.0 do essentially nothing. Kev ships a fitted
temperature and is the only engine calibrated out of the box — though at its
default 2.41 it is *under*confident on this set (mean 0.49 vs accuracy 0.75),
which `KEV_TEMPERATURE=1.3` fixes. Both temperature values here were fitted on
these 60 items and are not held out.

**The cross-encoder is the wrong tool.** bge-reranker-v2-m3 gets 0.200 on tool
routing: relevance between a prompt and a tool description is not the same
question as which tool to call, and short tool descriptions give it nothing to
match. It does reach 0.667 on skills (long descriptions, retrieval-shaped) and
0.900 on "none" (everything scores low, so `none` wins by default). Usable at
most as a cheap pre-filter to shrink a large skill catalog; not as a judge.

**Kev-4B was not downloaded.** Its own README measures 721 ms median on an M5
for five questions over a ~270-token state with a *new* state, against a 750 ms
deadline — and the prefix-diet feature has a new state on every prompt. It is
the accuracy leader in budget (0.797/0.837 vs 0.652/0.684 for 0.8B) and worth
revisiting only if the timeout is raised.

## 5. Against the sibling's replay cases

`~/.pi/agent/pi-jev/replay/cases/` holds the replay corpus (catalog.json,
prefix.jsonl, spec.jsonl, triage.jsonl). `bench/replay/cli.ts judge --judge local`
reads `PI_JEV_TIMEOUT_MS` (or `--timeout-ms`) for its deadline, so the offline
run uses 3,000 ms rather than the 750 ms production budget; the paired
kev replay numbers are in [bench/replay/RESULTS.md](../bench/replay/RESULTS.md).
Set `PI_JEV_BENCH_CONCURRENCY=1` for that run — `kev.serve` answers one request
at a time, so the bench's default 8-way fan-out measures its own queue (prefix
p50 2,654 ms at 8 concurrent vs 341 ms at 1).

Measured directly against the running sidecar, on the first 24 `prefix` cases
(catalog `14b40m7`: 76 skills, 18 tools):

| Request | p50 | p95 | max |
|---|---:|---:|---:|
| 3 questions (skill choice ×77, tool choice ×19, one noul), descriptions ≤255 | 678 ms | 817 ms | 1085 ms |
| same, descriptions truncated to 100 chars | **332 ms** | **489 ms** | 616 ms |
| skill choice only, descriptions ≤255 | 212 ms | 325 ms | — |
| skill choice only, descriptions ≤100 | 108 ms | 243 ms | — |
| skill choice only, names only (no descriptions) | 35 ms | 83 ms | — |

So the deadline is not a model problem, it is a *prompt-size* problem: the
option descriptions, not the state, dominate. Kev caches the state prefix but
not the question text, so a 76-option catalog is re-prefilled on every request
and once per question. Truncating skill descriptions to 100 characters — the
same "step zero" the top-level README already recommends for the context window
— puts the full three-question request comfortably inside 750 ms, and on these
cases it also *improves* `none` detection (4/15 → 11/15). This is now the
extension's `PI_JEV_DESC_CHARS` (default 120), which `bench/replay` applies too. A 6,127-token state
took 23.6 s, but that was the first request after server start; warm requests at
4.5k tokens are ~700 ms.

Accuracy on the replay cases is not reported here: most of the sampled non-`none`
cases have empty `usedSkills` (they used tools), and one gold skill
(`using-superpowers`) is not in its own case's catalog. Scoring those is
`cli.ts score`'s job, not this sidecar's.

## 6. Open issues

- 62-option ceiling on `--engine logprob` (single-token labels A–Z, a–z, 0–9). The real catalog is 76 skills, so **the logprob engine cannot serve the replay prefix cases at all** without a pre-filter; it now refuses them with `400 OptionLimit` instead of truncating. `--engine kev` is the default and has no such limit. Fix is either multi-token labels (one pass per label) or a lexical top-62 pre-filter.
- The block-noul finding means any triage feature needs its question wording pinned and regression-tested. 20 hand-labelled items is too few to trust the 0.75.
- `kev.serve` handles one request at a time and is a second process to supervise. A single-process engine that loads kev's pointer head directly would be better, but needs torch in this venv.
- Both fitted temperatures (kev 1.3, Qwen3-4B 6.0) were chosen on the same 60 items they are scored on.
- `timeoutMs` in the request body is accepted and ignored; the sidecar always runs to completion.
