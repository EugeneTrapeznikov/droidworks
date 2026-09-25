# Pi JEV Triage

A Pi extension that uses [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's decision model, to trim large tool results. It splits each big result into blocks, asks Jev which blocks the agent will need, and hides the rest behind a short stub the agent can restore with `pi_jev_recall`.

Tool output is 79% of the characters in my Pi sessions. On my 20 longest sessions this freed 9.7% of the context, and on SWE-bench Lite it solved the same tasks at every threshold.

## Install

```bash
pi install npm:pi-jev-triage
```

1. Set a key for hosted Jev, from either provider:
   - [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev): `VERCEL_API_KEY`, in your shell or in `~/.config/vercel/.env`.
   - [TypeSafe](https://typesafe.ai): `TYPESAFE_API_KEY`, in your shell or in `~/.config/typesafe/.env`.

   The extension uses whichever key it finds (Vercel if both). To pick one explicitly, set `PI_JEV_JUDGE=vercel` or `PI_JEV_JUDGE=typesafe`.
2. The extension starts in shadow mode: it judges every large tool result and logs the decision, but hides nothing. To let it trim results, add this to `~/.pi/agent/settings.json`:

   ```json
   "pi-jev": { "shadow": false }
   ```

   or run Pi with `PI_JEV_SHADOW=0`.
3. Start a new Pi session, or `/reload` a running one.

Try it for one session without installing: `pi -e npm:pi-jev-triage`.

## How it works

```text
tool returns a big result (read, bash, grep, find, ls, fetch_url, MCP; ≥ 2,000 chars)
    ↓
split it into blocks of ≤ 25 lines
    ↓
Jev scores each block: "will the agent need this?" (with the latest prompt and tool name)
    ↓
blocks scoring ≤ 0.20 → replaced with a [pi-jev: hid lines …] stub
    ↓
agent needs it after all? → pi_jev_recall brings it back
```

- **Fail open.** If Jev times out (15 s) or errors, the full result goes through.
- **Judge once, at the door.** Each result is rewritten when it arrives. Earlier messages are never touched, so the prompt cache stays warm.
- **Keep the edges.** The first and last block always stay, and so do blocks Jev is unsure about.
- **Skip small cuts.** If less than 20% of a result would be hidden, it stays whole. Diffs and JSON pass through unjudged.

The block questions come from [winnow](https://github.com/GhalebDweikat/winnow), a similar project for Claude Code. Every setting (threshold, judge, state cap, tools, logging) is documented in [extension/README.md](extension/README.md).

## Results

**Session replay** ([results](bench/session-replay/results-2026-09-23.md)): my 20 longest Pi sessions (15,261 model calls) replayed through hosted Jev, context rebuilt offline. Judge spend: $0.65.

| drop ≤ | context freed | unique loss |
|---|--:|--:|
| 0.10 | 3.3% | 4.3% |
| 0.15 | 6.5% | 4.6% |
| **0.20 (default)** | **9.7%** | 5.9% |

*Unique loss*: hidden blocks whose content came back later in the session with no other source. It is a text-match proxy, not a task outcome.

**SWE-bench Lite 20** ([RESULTS.md](bench/swe/RESULTS.md)): GPT-6 Sol in Pi.

| drop ≤ | solved | context saved | recalls |
|---|--:|--:|--:|
| 0.10 | 10 / 20 | 3.1% | 4 |
| 0.15 | 10 / 20 | 7.0% | 6 |
| **0.20** | **10 / 20** | **7.4%** | 8 |

The same 10 tasks were solved at every threshold, and no failure traced back to a hidden block.

**Limits.** The win is context headroom, not money: most hidden tokens would have been cache reads at about 0.1× the input price. Hosted Jev sheds load with 429/503 errors; those calls fail open, so less gets trimmed.

## Repo layout

- `extension/`: the extension. `bun test` in `extension/`.
- `bench/swe/`: SWE-bench arms for the moa-harness runner.
- `bench/session-replay/`: the session replay. Only aggregate results are committed.
- `scripts/`: session mining (`mine-corpus-triage.py` produces the corpus numbers above) and a first-turn context probe.
