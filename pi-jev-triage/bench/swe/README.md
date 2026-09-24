# Tier 3 — SWE-bench Lite 20, Pi arms

Results: [RESULTS.md](RESULTS.md).

Paired per-task coding-agent efficiency for pi-jev triage. Rig is
moa-harness `bench/run.py --host pi --arms-config <this dir>/arms.json`;
the arms file replaces that rig's built-in MoA legs. Hypothesis: **model calls
and billed tokens drop, resolve rate holds within noise.**

## Arms (`arms.json`)

| Arm | Pi flags | Extension | Env |
|---|---|---|---|
| `off` | `--no-extensions --no-context-files --no-skills --no-prompt-templates --no-themes` | — | — |
| `full` | `--no-context-files --no-prompt-templates --no-themes` | — | — |
| `triage-local` | same as `full` | `extension/src/index.ts` | `PI_JEV_FEATURES=triage PI_JEV_SHADOW=0 PI_JEV_JUDGE=local PI_JEV_LOCAL_URL=http://127.0.0.1:47412 PI_JEV_STATE_CHARS=24000` (JevK5 sidecar; judge timeout is the 15 s default) |
| `triage-vercel` | same | same | `PI_JEV_FEATURES=triage PI_JEV_SHADOW=0 PI_JEV_JUDGE=vercel` |
| `triage-vercel-010` / `-015` / `-020` | same | same | `triage-vercel` + `PI_JEV_DROP=0.10` / `0.15` / `0.20` (drop-threshold sweep) |

7 arms. `full` is the user's normal Pi (skills and installed extensions on) with
no pi-jev, so it is the control, not "all features on". Two deliberate choices:

- **pi-jev arms carry `full`'s flags, not `off`'s.** Skills and installed
  extensions stay on, so `full` → `triage-*` is a single-variable comparison.
  `off` is the floor, not the control.
- **`--no-context-files` on every arm.** A SWE-bench checkout has no AGENTS.md;
  keeping the flag stops the host repo's from leaking into some arms only.

`PI_JEV_LOG` is **not** in the file: the runner sets it per rollout to
`results/<arm>/decisions-<instance>.jsonl`. Any `PI_JEV_*` in the parent shell is
stripped before the child starts, so an arm is exactly what the file says.
`VERCEL_API_KEY` is inherited — `source ~/.config/vercel/.env` first; run.py
prints whether it saw it.

## The real run

```bash
source ~/.config/vercel/.env                      # VERCEL_API_KEY, for judge=vercel
cd <moa-harness>/bench
ARMS=<droidworks>/pi-jev-triage/bench/swe/arms.json

# all 4 arms (80 rollouts); predictions are per arm under results/
python run.py --host pi \
  --arms-config $ARMS \
  --arm all \
  --model sol --provider openai-codex --workers 2

python score.py --workers 2 \
  --arms-config $ARMS
```

`--arm` takes a comma list (e.g. `off,full,triage-local`); `--limit N` truncates
the task list for a smoke. `--workers 2`: the 36 GB laptop swapped out with kev,
Docker and ~6 Pi sessions at once.

Dry run first (no Docker, no tokens, fabricates session + decision logs in the
real schemas so the metric parsers actually run):

```bash
python run.py --dry-run --host pi \
  --arms-config $ARMS --limit 3
python score.py --dry-run \
  --arms-config $ARMS
python -m unittest test_pijev_arms
```

## What it costs

| | |
|---|---|
| Rollouts | 20 tasks × arms; 4 arms = 80 |
| Wall clock | ~1–1.5 h per 3–4 arms at `--workers 5`, once images are cached |
| First-run Docker | +30–60 min pulling/building per-repo SWE-bench images |
| Docker disk | ~60–120 GB across the 12 repos in `lite-20.json`; `docker system prune -a` after |
| Tokens | Sol via Codex OAuth (subscription capacity, not API billing). ~$1–2 retail-equivalent per arm per 20 tasks at the measured p50 |
| Judge | Jev at $0.042/M input, output free — rounding error next to the main model |

`score.py` needs `pip install swebench` and Docker running; it evaluates each
arm's predictions separately, so each extra arm is another full harness pass.

## Reading `report.md`

`results/report.md`, in order:

1. **Resolve rate** — per arm. The safety check: triage arms must not fall below
   `full` by more than noise.
2. **Pairwise deltas** — per-instance `fail→pass` / `pass→fail` flips.
3. **Wall-clock** — arm total and mean per instance.
4. **Tokens, calls & cost** — the headline. `input+cacheRead` is the billed-token
   column (cacheRead is 10× cheaper, so read `cost ($)` alongside it, never
   tokens alone). `model calls` is the count of assistant messages with real
   usage, summed from each rollout's Pi session JSONL.
5. **pi-jev decisions** — `triage bytes hidden`, `recall turns`, judge latency
   and fail-open, from the per-instance decision logs. The runner's `prefix
   tokens saved` / `spec hits` columns read 0 for these arms. These are the *claimed*
   savings; columns 4 are the *billed* ones. JetBrains measured RTK at +7.6%
   cost despite 60–90% output reduction — if hidden bytes go up and billed
   tokens don't go down, the feature is losing.
6. **Paired deltas & significance** — vs `off` and vs `full`. Exact two-sided
   binomial sign test on resolved (with n=20 and a handful of flips it will
   rarely be significant — that is the point: it tells you resolve rate held,
   not that it improved). Wilcoxon signed-rank on calls and on
   `input+cacheRead`; those are where a real effect should show. scipy when
   installed, a stdlib normal approximation otherwise — the report says which.
7. **Per-instance metrics** — one table per arm: resolved, calls,
   `input+cacheRead`, cost, wall. Use it to find the one runaway task before
   believing an arm mean.

Raw per-rollout numbers live in `results/preds-<arm>.meta.json` under
`instances.<id>.metrics`, including `first_turn_input`,
`cacheWrite`, `reasoning` and `tool_calls`.
