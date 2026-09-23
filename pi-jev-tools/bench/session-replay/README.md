# Session replay

How much context real Pi sessions would have carried with triage on. `replay.ts` picks the top N sessions under `~/.pi/agent/sessions` by model calls (top-level files over 50 KB; paths or cwds containing `bench`, `pi-jev`, `swe`, `.session/`, or `scratchpad` are excluded), walks each in write order, and sends every tool result that passes the extension's gate to the judge with the same request `extension/src/triage/core.ts` builds. The rewritten text goes into a second timeline; every recorded model call is measured against both. The model is not re-run.

```bash
PI_JEV_JUDGE=vercel bun run bench/session-replay/replay.ts --top 20 --date 2026-09-23
PI_JEV_JUDGE=mock   bun run bench/session-replay/replay.ts --date dry   # offline plumbing check
bun test bench/session-replay
```

- Judge: 15 s per attempt, up to 5 attempts with backoff on 429/502/503/timeout (`bench/replay/judge.ts` `askWithBackoff`), 4 sessions at a time. A result that still fails is kept verbatim and counted as fail-open.
- Tokens: each session's recorded input+cacheRead tokens over its transcript chars gives chars/token (fallback 3.3). Saved tokens split into input and cacheRead by each call's recorded proportions and are priced at that call's recorded rates, minus 155 tokens/call of recall overhead.
- Harm proxy: a hidden block is flagged when one of its identifiers (6+ chars with `_`, `/`, or camelCase) appears in the original session's later assistant text or tool inputs.

Outputs next to the script: `results-<date>.md` (tables), `decisions-<date>.jsonl` (one line per judged or skipped result: outcome, block probabilities, chars before and after), and `flagged-<date>.md` (the 10 highest-overlap hidden blocks as raw session text, for hand review; not committed).
