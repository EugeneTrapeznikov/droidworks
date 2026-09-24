# pi-jev live bench (Tier 2)

## 2026-09-23: `openai-codex/gpt-6-sol`, three arms (current code)

Generated 2026-09-23T20:43Z from `results/gpt6sol-2026-09-23` (`bun score.ts --in results/gpt6sol-2026-09-23`).

Rig: `pi -p --session-dir <tmp> --no-context-files --provider openai-codex --model gpt-6-sol [-e extension] <prompt>`, stdin ignored, from the fixed scratch fixture (reset per arm invocation), user's normal extensions and skills ON. 30-prompt set, `--concurrency 2`, arms run in order `off`, `triage-local`, `triage-vercel`. Triage arms: `PI_JEV_SHADOW=0`, code defaults (`winnow` question set, `tool` in state, 15 s timeout). `triage-local` = JevK5 v0.2.0 via sidecar `:47412`, `PI_JEV_STATE_CHARS=24000`; `triage-vercel` = hosted Jev, 80k cap. A tier-3 agent ran 2 Pi workers concurrently on the same laptop.

### Cost and context per arm

First-turn prefix = `usage.input + usage.cacheRead` on the first call; cold = billed first-turn input where `cacheRead == 0`. Tokens/run = `input + cacheRead + output`. Cost is Pi's retail-equivalent estimate; the runs are on a subscription, nothing was billed at these rates.

| arm | n | fail | first-turn prefix median | Δ vs off | cold n | cold billed median | calls/run mean | calls/run median | tokens/run mean | tokens/run median | cost (retail-equiv.) | wall p50 | timedOut |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `off` | 30 | 0 | 9,975 | +0 | 5 | 9,977 | 6.3 | 5.0 | 115,510 | 58,415 | $1.96 | 30.6 s | 1 |
| `triage-local` | 30 | 0 | 10,134 | +159 | 0 | — | 5.9 | 5.0 | 89,803 | 58,400 | $1.60 | 34.0 s | 1 |
| `triage-vercel` | 30 | 0 | 10,129 | +154 | 3 | 10,139 | 4.8 | 4.5 | 63,172 | 55,378 | $1.36 | 30.2 s | 1 |

### Triage

`bytes hidden %` = `1 − Σ bytesAfter / Σ bytesBefore` over every judged tool result (error-gate and below-ratio passes count as 0%). Stubs are counted in the session transcript's `toolResult` messages, i.e. what the model actually saw.

| arm | results judged | judge p50 | judge p95 | Σ chars before | Σ chars after | hidden % | pruned | error-gate | skip<ratio | fail-open | stubs/run | `pi_jev_recall`/run |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `triage-local` | 40 | 2,281 ms | 14,811 ms | 356,954 | 354,977 | 1% | 1 | 1 | 36 | 2 | 0.03 | 0.00 |
| `triage-vercel` | 25 | 497 ms | 1,118 ms | 198,584 | 177,279 | 11% | 4 | 4 | 17 | 0 | 0.13 | 0.03 |

### Notes

- **No measurable triage effect.** Paired per-prompt median Δ tokens vs `off`: `triage-local` −4, `triage-vercel` −738; median Δ calls 0 for both. Triage hid 1,977 chars (local) and 21,305 chars (vercel) across 30 runs, about 0.5k and 6k tokens, while the arm totals differ by 0.8M and 1.6M tokens. The mean tokens/run and cost gaps are run-to-run variance in a few long prompts: `tool-02` 23 / 18 / 7 calls, `skill-03` 19 / 14 / 4, `tool-06` 10 / 6 / 5 (off / local / vercel). The first `triage-vercel` `tool-02` attempt took 27 calls ($0.69). Read the medians, not the means.
- **Prefix cost of triage: +155 tokens** (+1.6%) on the first turn, the `<pi-jev>` system-prompt section plus the `pi_jev_recall` schema.
- **Triage rarely fires on this set.** The fixture files are tiny; most judged results are skill and doc reads. `skip<ratio` dominates (36/40 local, 17/25 vercel): the judge keeps most blocks, so under 20% would be hidden. JevK5 pruned 1 result in 40; Jev pruned 4 in 25.
- **Stubs reach the model** in shadow-off mode: local 1 stub (`tool-04`), vercel 4 stubs, one each in `none-02`, `none-04`, `tool-02`, `tool-04`. `pi_jev_recall` was called once (`tool-02`, vercel).
- **JevK5 is slow here:** p50 2.3 s, p95 14.8 s against the 15 s deadline; both `triage-local` fail-opens are 15.0 s timeouts in `tool-02` (9 and 14 judged blocks). They are kept (a real latency outcome, not an upstream fault).
- **Hosted Jev flapped.** Probe `test/judge.live.ts` 3×: 2 clean, 1 HTTP 503. The first `triage-vercel` pass had 4 fail-opens (`skill-05` 1, `tool-02` 3; all < 0.8 s, i.e. HTTP errors, not timeouts); the rerun of both had 2 more in `tool-02`; the third `tool-02` run was clean. Every prompt in the table has one clean run; the discarded runs are in `results/gpt6sol-2026-09-23-QUARANTINE-vercel-failopen/attempt{1,2}`. Reruns started from a freshly reset fixture.
- **Outcomes:** `score.ts` has no per-prompt answer expectations (the routing labels are for the deferred prefix-diet idea), so outcome changes are not scored. No run failed in any arm.
- `tool-03` hits the 10-minute cap in every arm (known hang after scheduling); its measurements are kept (`timedOut: true`).
- vs the gpt-5.6-sol baseline below: first-turn prefix 13,899 → 9,975, cost/30 runs $5.67 → $1.96 (retail-equiv.).

## Pre-2026-09-23 code, `gpt-5.6-sol` (`results/off-baseline`)

Generated 2026-09-23T08:00:54.241Z from `results/off-baseline`.

Rig: `pi -p --session-dir <tmp> --no-context-files <prompt>` from a fixed scratch fixture repo, user's normal extensions and skills ON, default model (`gpt-5.6-sol`). 30-prompt set (`routing-set.json`).

### Cost and context per arm

First-turn prefix = `usage.input + usage.cacheRead` on the first model call. The provider caches prefixes implicitly **across** sessions, so billed `input` alone swings ~2× between otherwise identical runs; the cold column is the billed subset where `cacheRead == 0`.

| arm | n | fail | first-turn prefix mean | median | Δ median vs off | cold n | cold billed median | calls/run | Σ input | Σ cacheRead | cost | wall p50 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `off` | 30 | 0 | 13902 | 13899 | +0 | 16 | 13921 | 6.2 | 757,040 | 4,456,704 | $5.67 | 56.8s |

### Findings

#### The live `off` baseline is ~13.9k, not 16,250

The README's 16,250 came from the repo cwd with two `AGENTS.md` files loaded. This rig runs `--no-context-files`
from a scratch fixture, and the catalog has since shrunk to 46 skills, so the live baseline is **13,899 median /
13,902 mean** first-turn prefix (n=30, spread 13,539–14,308, ±3%). Composition from `scripts/probe-window.ts` on
the same cwd: system prompt 19,886 chars, active tool schemas 37,433 chars, 46 skills, 18 of 26 registered tools
active.

#### Billed `usage.input` is not the prefix size

The provider's implicit prefix cache is keyed on content, not on session, so it hits **across** `pi -p` runs:
16 of 30 baseline runs were cold (`cacheRead == 0`, median 13,921 billed) and 14 came back with
`input ≈ 6.8k, cacheRead = 6,912` for the identical prompt prefix. Reporting billed input alone would have shown a
phantom 2× spread. Every context number in the table above is `input + cacheRead`; `cost` stays billed-actual.

#### Triage numbers are being rerun

Triage numbers from before 2026-09-23 used the `sharpened` block question and sent no `tool` in the judge
`state`; they are being rerun with the `winnow` question set and `{ task, tool }` state. The prefix-diet and
speculative-read arms are out of this bench; their measured numbers are in the root README, Future ideas.

#### Rig side effects

Prompts mutate the cwd: `tool-03` created a real cron job (fixture-local `.pi/schedule-prompts.json`, not the
user's config) and `skill-03` wrote `src/store.test.ts`, which later prompts then read. `run.ts` wipes and
re-materializes the fixture once per invocation (`--no-reset` opts out); runs inside one invocation still share the
cwd at concurrency 3. `tool-03` also hangs after scheduling and is killed at the 10-minute cap — its measurements
are kept (`timedOut: true`) since the model call completed.
