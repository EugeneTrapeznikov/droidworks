# pi-jev extension

Pi extension that uses a decision model (Jev, or a local stand-in) to cut context with one capability: tool-result triage at ingestion. Large results are split into blocks, the judge answers one noul per block plus one error question (P ≥ 0.5 keeps the whole result; there is no regex fallback), and dead runs are hidden behind a `pi_jev_recall` stub.

Layout (each directory is owned by one work package; `src/judge/types.ts` is the only shared contract):

```
extension/
  src/index.ts            entry: reads config, builds judge, registers triage
  src/settings.ts         "pi-jev" block of ~/.pi/agent/settings.json
  src/judge/              types.ts (contract), shared.ts (fetch + parsers), vercel.ts, typesafe.ts
                          (also serves judge=local), mock.ts (tests), index.ts (factory)
  src/triage/             tool_result hook: block split, batched nouls, stubs + recall tool
  src/telemetry.ts        DecisionRecord JSONL writer
  test/                   bun test, no network
```

`src/judge/types.ts` is frozen. Its `prefix` / `spec` feature literals and the `choice` / `score` question shapes stay for the deferred ideas in the root README; triage asks only `noul`.

## Configuration

Pi has no extension-settings API, so the extension reads the `"pi-jev"` block of Pi's `settings.json`
directly (`$PI_CODING_AGENT_DIR/settings.json`, default `~/.pi/agent/settings.json`), once at load.
Precedence: `PI_JEV_*` env var > `settings.json` > code default. Every key is optional. A malformed
file or a non-object block logs one warning and the extension runs on defaults.

```json
"pi-jev": {
  "judge": "kev",
  "questionSet": "winnow",
  "timeoutMs": 15000,
  "shadow": true,
  "stateChars": { "vercel": 80000, "typesafe": 80000, "local": 24000 },
  "localUrl": "http://127.0.0.1:47411",
  "judges": {
    "kev":   { "url": "http://127.0.0.1:47411", "stateChars": 24000 },
    "jevk5": { "url": "http://127.0.0.1:47412", "stateChars": 24000, "drop": 0.2, "maxBlocksPerCall": 8 }
  },
  "triage": {
    "tools": ["read", "bash", "grep", "find", "ls", "fetch_url", "mcp"],
    "minChars": 2000, "blockLines": 25, "blockChars": 1500,
    "drop": 0.2, "keep": 0.5, "minPruneRatio": 0.2, "skipStructured": true
  }
}
```

- `judge` is a backend (`vercel`, `typesafe`, `local`, `mock`) or a key of `judges`. A named
  judge with a `url` runs as backend `local` against that url; `PI_JEV_JUDGE=jevk5` selects it too.
- State cap order: `PI_JEV_STATE_CHARS` > the named judge's `stateChars` > `stateChars[<judge name>]` >
  `stateChars[<backend>]` > code default (80000, `local` 24000).
- Local url order: `PI_JEV_LOCAL_URL` > the named judge's `url` > `localUrl`.
- Drop/keep order: `PI_JEV_DROP` / `PI_JEV_KEEP` > the named judge's `drop` / `keep` > `triage.drop` /
  `triage.keep` > code default (0.20 / 0.5). The `jevk5` block above is the recommended JevK5 setup:
  on real SWE reads JevK5 scores blocks at min 0.107 / median 0.419, so a 0.10 drop line hides nothing.
- `maxBlocksPerCall` (named judge only; `PI_JEV_MAX_BLOCKS_PER_CALL` wins; default 0 = one request):
  the judged blocks go out in consecutive chunks of at most N, one request after another. Each chunk
  carries the same task and tool, only its own blocks, and the error question. A chunk whose error
  answer is ≥ 0.5 keeps the whole result. All chunks share the one `timeoutMs` deadline, and any chunk
  timeout or error passes the result through untouched, never a partial rewrite. JevK5 re-encodes the
  state per question, so latency climbs past ~7 blocks (12 blocks 10 s; 19 blocks timed out at 15 s).
- `shadow` defaults to `true`; set `false` to let triage rewrite results.

When triage is active and not in shadow mode, `before_agent_start` adds a constant `<pi-jev>` section to
`systemPromptOptions.sections` (the stub format and `pi_jev_recall`). It never returns `{ systemPrompt }`,
which would replace the structured prompt and rewrite the cache prefix every turn.

Env overrides. Each wins over its `settings.json` key; `PI_JEV_FEATURES`, `PI_JEV_LOG`, `PI_JEV_CACHE_DIR`, `PI_JEV_TYPESAFE_URL`, `PI_JEV_MOCK_SEED` and the API keys are env-only:

| Var | Values | Default |
|---|---|---|
| `PI_JEV_JUDGE` | `vercel`, `typesafe`, `local`, `mock` (tests only), or a `judges` name | `vercel` if `VERCEL_API_KEY`/`AI_GATEWAY_API_KEY` is set, else `typesafe` if `TYPESAFE_API_KEY` is set, else `vercel` |
| `PI_JEV_FEATURES` | `triage`; empty disables the extension | `triage` |
| `PI_JEV_SHADOW` | `1` decides and logs, never mutates | `1` |
| `PI_JEV_LOG` | path to decision JSONL | `~/.pi/agent/pi-jev/decisions.jsonl` |
| `PI_JEV_TIMEOUT_MS` | judge deadline; matches winnow's `WINNOW_JUDGE_TIMEOUT`. 750 was the kev-on-laptop tuning | `15000` |
| `PI_JEV_LOCAL_URL` | sidecar base URL for `local` | |
| `PI_JEV_TRIAGE_TOOLS` | tools `triage` inspects; a name also matches its `_`-prefixed variants (`mcp` covers `mcp__srv__tool`) | `read,bash,grep,find,ls,fetch_url,mcp` |
| `PI_JEV_TRIAGE_MIN_CHARS` | results shorter than this are passed through | `2000` |
| `PI_JEV_BLOCK_LINES` | max lines per triage block | `25` |
| `PI_JEV_BLOCK_CHARS` | max chars per triage block; long-line output (JSON, minified, fetched pages) gets fewer lines per block so it is still judged; a single longer line is hard-split into pieces that recall as the whole line | `1500` |
| `PI_JEV_DROP` / `PI_JEV_KEEP` | hide at P ≤ drop, keep verbatim at P ≥ keep, uncertain stays; wins over `judges.<name>.drop` / `keep` | `0.20` / `0.5` |
| `PI_JEV_MAX_BLOCKS_PER_CALL` | judged blocks per judge request, sent as sequential chunks under one deadline; `0` = one request; wins over `judges.<name>.maxBlocksPerCall` | `0` |
| `PI_JEV_MIN_PRUNE_RATIO` | skip the rewrite unless this fraction of chars would be hidden | `0.2` |
| `PI_JEV_SKIP_STRUCTURED` | pass unified diffs (`git diff`, `git show`, bare hunks) and JSON/JSONL bodies through unjudged, logged as `skip_structured`; `0` triages them | `1` |
| `PI_JEV_STATE_CHARS` | judge state cap (task context + tool name + blocks); see below | `80000` for `vercel`/`typesafe`/others, `24000` for `local` |
| `PI_JEV_QUESTION_SET` | triage block + error-gate wording: `winnow` (winnow v0.5.0 `structured` set, flattened), or `sharpened` | `winnow` |
| `PI_JEV_CACHE_DIR` | full originals behind `pi_jev_recall` | `~/.pi/agent/pi-jev/cache` |
| `PI_JEV_TYPESAFE_URL` | base URL override for `typesafe` (e.g. `https://ai-gateway.vercel.sh/typesafe`) | `https://api.typesafe.ai` |
| `PI_JEV_MOCK_SEED` | seed for `mock` | `0` |
| `VERCEL_API_KEY` | from `~/.config/vercel/.env`, never read by code from that file. `AI_GATEWAY_API_KEY` also accepted | |
| `TYPESAFE_API_KEY` | for `judge=typesafe`; `local` sends no auth | |

### Judged-state cap per backend

`buildState` follows winnow: blocks go to the judge in full text, the leading blocks are included
while they fit in `cap - task - tool` (task capped at 2,000 chars), and the first block that does not
fit ends the run. The rest stay unjudged and visible; no block text is ever truncated. Telemetry
`detail.judged` counts the blocks sent, `detail.blocks` the total. Budgets at ~3.5 chars/token for code:

| Backend | Limit (primary source) | `PI_JEV_STATE_CHARS` |
|---|---|---|
| `vercel` / `typesafe` (jev-1.13) | 32k tokens for `state` + the longest question; 64k for `state` + all questions ([Models](https://docs.typesafe.ai/models.md)); gateway lists a 32,000 context window ([Vercel](https://vercel.com/ai-gateway/models/jev)); `/v1/evaluate` docs state no separate limit | default `80000` (~23k tokens; leaves ~9k for the longest question and room under 64k for ~50 winnow-sized questions). Accuracy drops as irrelevant state grows ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)), so do not fill 32k |
| `local` → kev | 8,192 tokens per question, state included; over it answers 422 | default `24000` (~6.9k tokens) |
| `local` → JevK5 v0.2.0 `jevk5-serve` | no truncation or refusal in `jevk5-serve`/`runtime.py`; Qwen3.5-4B `max_position_embeddings` 262,144; CUDA graphs up to 4,096 tokens, longer inputs run eagerly (README: eager ~70 ms vs graphed 13 ms on H100) and every question re-encodes the whole state; the 16,384-token refusal is only in the JevBench adapter ([allebee/jevk5@v0.2.0](https://github.com/allebee/jevk5/tree/v0.2.0)) | `24000` like kev; `12000` (~3.4k tokens + question + chat template) is a speed hint that stays inside the 4,096 graph |
| `mock` | none | any |

The default follows the judge (`vercel`/`typesafe` 80000, `local` 24000); settings `stateChars` and
`PI_JEV_STATE_CHARS` override it (see Configuration). JevK5 runs at 24000 like kev; 12000 is only a
speed hint (keeps a JevK5 request inside its 4,096-token CUDA graph). For reference winnow defaults
`WINNOW_MAX_STATE_CHARS` to 120,000 ([config.py@0bf46619](https://github.com/GhalebDweikat/winnow/blob/0bf46619daee883b278c7f42ee994f963d093321/sidecar/src/winnow/config.py)).

Run: `pi -e pi-jev-triage/extension/src/index.ts`. With the user's global extensions discovered, `-e` was observed to register nothing, silently; pass `-ne` or `pi install` the extension, and confirm a decision record lands in `PI_JEV_LOG` before trusting a run.
