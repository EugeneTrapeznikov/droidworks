## Findings

### The live `off` baseline is ~13.9k, not 16,250

The README's 16,250 came from the repo cwd with two `AGENTS.md` files loaded. This rig runs `--no-context-files`
from a scratch fixture, and the catalog has since shrunk to 46 skills, so the live baseline is **13,899 median /
13,902 mean** first-turn prefix (n=30, spread 13,539–14,308, ±3%). Composition from `scripts/probe-window.ts` on
the same cwd: system prompt 19,886 chars, active tool schemas 37,433 chars, 46 skills, 18 of 26 registered tools
active.

### Billed `usage.input` is not the prefix size

The provider's implicit prefix cache is keyed on content, not on session, so it hits **across** `pi -p` runs:
16 of 30 baseline runs were cold (`cacheRead == 0`, median 13,921 billed) and 14 came back with
`input ≈ 6.8k, cacheRead = 6,912` for the identical prompt prefix. Reporting billed input alone would have shown a
phantom 2× spread. Every context number in the table above is `input + cacheRead`; `cost` stays billed-actual.

### Triage numbers are being rerun

Triage numbers from before 2026-09-23 used the `sharpened` block question and sent no `tool` in the judge
`state`; they are being rerun with the `winnow` question set and `{ task, tool }` state. The prefix-diet and
speculative-read arms are out of this bench; their measured numbers are in the root README, Future ideas.

### Rig side effects

Prompts mutate the cwd: `tool-03` created a real cron job (fixture-local `.pi/schedule-prompts.json`, not the
user's config) and `skill-03` wrote `src/store.test.ts`, which later prompts then read. `run.ts` wipes and
re-materializes the fixture once per invocation (`--no-reset` opts out); runs inside one invocation still share the
cwd at concurrency 3. `tool-03` also hangs after scheduling and is killed at the 10-minute cap — its measurements
are kept (`timedOut: true`) since the model call completed.
