# pi-jev SWE-bench Lite 20 (Tier 3)

## 2026-09-23: `openai-codex/gpt-6-sol`, three arms

Raw results (predictions, per-task decision logs) stay local in the runner's git-ignored `results/` directory.

Rig: `run.py --host pi --arms-config arms.json --model gpt-6-sol --provider openai-codex --workers 2`, arms run in order
`full`, `off`, `triage-vercel`; `score.py --workers 2` (swebench 4.1.0, Docker, x86_64 images under emulation on arm64).
Triage arm: `PI_JEV_SHADOW=0`, `winnow` question set, tool in state, 15 s timeout, 80k state cap, drop 0.1.
Tokens = `input + cacheRead + output` per task. Cost is Pi's retail-equivalent estimate; the runs used subscription
capacity, nothing was billed at these rates.

| arm | resolved | calls p50 | tokens p50 | wall p50 | cost p50 (retail-equiv.) | cost total (retail-equiv.) |
|---|--:|--:|--:|--:|--:|--:|
| `off` | 9/20 | 9.5 | 78,067 | 65 s | $0.067 | $1.46 |
| `full` | 9/20 | 12 | 246,913 | 76 s | $0.116 | $2.80 |
| `triage-vercel` | 10/20 | 14 | 247,728 | 87 s | $0.107 | $2.82 |

Paired, exact two-sided sign test on resolved; Wilcoxon (scipy) on per-task calls and `input+cacheRead`:

| comparison | →pass | →fail | sign p | calls Δ (p) | input+cacheRead Δ (p) | cost Δ |
|---|--:|--:|--:|--:|--:|--:|
| `triage-vercel` vs `full` | 1 (pytest-11148) | 0 | 1.000 | +4.9% (0.82) | −0.7% (0.50) | +0.9% |
| `triage-vercel` vs `off` | 1 (django-10924) | 0 | 1.000 | +39.9% (<0.001) | +223.6% (<0.001) | +93.1% |
| `full` vs `off` | 1 (django-10924) | 1 (pytest-11148) | 1.000 | +33.3% (0.005) | +225.8% (<0.001) | +91.4% |

`triage-vercel` / `psf__requests-1963` is counted resolved after a single-instance rescore: the first harness pass
failed two PASS_TO_PASS tests on an HTTP 502 from live httpbin during scoring; the patch is byte-identical to `off`'s
passing patch. Triage hid lines of `models.py`, `adapters.py`, `cookies.py` there; the fix file `sessions.py` was read
in full (that judge call failed open). That test module depends on live httpbin, so any arm can flake on it.

### Triage (`triage-vercel`)

| | |
|---|--:|
| tool-result chars per task, p50 before → after | 40,818 → 34,348 (16% hidden) |
| chars hidden, arm total | 108,400 of 824,875 judged (13%) |
| judge decisions | 116: 28 pruned, 56 below prune ratio, 9 error-gate, 23 fail-open |
| judge latency (answered) | p50 456 ms, p95 4,064 ms |
| stubs seen by the model | 36 (p50 1/task; 17 of 20 tasks) |
| `pi_jev_recall` calls | 5 (p50 0/task) |
| fail-opens | 23/116, on 14 of 20 tasks; 1 hit the 15 s timeout, 22 failed fast (0.3–12 s, upstream errors; live probes before the run saw HTTP 503s) |

### Findings

- **No billed-token effect.** Triage hid ~108k chars (~30k tokens) against 6.2M `input+cacheRead` for the arm; paired
  deltas vs `full` are inside noise. Per-task median it added ~11 s wall and ~2 model calls.
- **`full` vs `off`:** same 9/20 at 3.2× tokens and 1.9× cost. The difference is the skills + installed-extension
  prefix re-read every turn (cacheRead p50 214k vs 45k), not extra work.
- **`triage-local`: not run.** Dropped: JevK5 (remote GPU host, sidecar `:47412`) hid nothing at the 0.1 drop threshold
  (min block P 0.107 over 72 judged blocks in two smokes) and timed out at 15 s on large reads.

### Bench bugs fixed on this run

- **Decision log leaked into the patch.** With a relative `--out-dir`, `PI_JEV_LOG` resolved against the rollout cwd,
  so the log was written inside the checkout and captured by `git diff`. `run.py` now resolves the log and session paths
  to absolute before starting Pi (regression test in `test_pijev_arms.py`).
- **arm64 SWE-bench images counted as fails.** swebench pulls eval images for the host platform; on Apple Silicon that
  404s and every instance was scored as an error, reported as unresolved. `score.py` now pre-pulls the
  `linux/amd64` images on arm64 and exits non-zero whenever the harness reports errored instances.

### 2026-09-23: Threshold arms (drop 0.10 vs 0.15), final code

Same rig and 20 tasks, arms `triage-vercel-010` and `triage-vercel-015` (`PI_JEV_DROP` pinned per arm, see
[README.md](README.md)), run on the final extension code. Cost is retail-equivalent, as above.

| arm | resolved | vs `full` / `off` | tokens p50 | wall p50 | calls p50 | cost p50 / total (retail-equiv.) | chars hidden p50 | stubs | recalls | fail-open |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `triage-vercel-010` | 10/20 | +1/−0, +1/−0 | 212,536 | 70 s | 12 | $0.099 / $3.23 | 8% | 22 | 4 | 32/114 |
| `triage-vercel-015` | 10/20 | +1/−0, +1/−0 | 209,514 | 76 s | 13 | $0.109 / $2.78 | 19% | 49 | 6 | 28/112 |

Flips are paired against `full` (9/20) and `off` (9/20); sign p = 1.0 for all four. Both arms resolve the same 10 tasks.

- **No recall-linked failure.** No task that recalled a hidden block failed where a control passed.
- **Skill-file recalls.** 4 of the 10 recalls were the model re-reading its own skill file after triage hid part of it.
- **Caveats.** The `full` and `off` controls come from the earlier three-arm run on older code, not a same-day rerun.
  Fail-open was 25–28% of judge calls, driven by upstream hosted-Jev errors, so both arms judged fewer results than
  a healthy gateway would.
