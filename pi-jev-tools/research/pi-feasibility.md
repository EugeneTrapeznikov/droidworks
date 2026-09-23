# Pi JIT-context ("pi-jev") feasibility report

Pi `@earendil-works/pi-coding-agent` v0.87.1 at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.
Cwd: a private working repo (repo A). Provider `openai-codex`, model `gpt-5.6-sol`.

Method: a throwaway extension (`probe.ts`) hooked `before_agent_start` (dumps `systemPrompt`,
`systemPromptOptions`, `pi.getAllTools()` with `sourceInfo`) and `context_with_system` (dumps the exact
message array handed to the provider, including `system.sections` and `system.toolsAdded`).
Two live runs of `pi -p "reply with the single word ok"` with the user's normal config plus `-e probe.ts`.
Raw probe output is not committed.

---

## A. Exact initial-window breakdown (live, calibrated)

### A.0 Calibration

No tokenizer is bundled with Pi (`node_modules/` has no tiktoken/gpt-tokenizer; `python3 -c "import tiktoken"`
fails). Instead of chars/4 I solved a **two-rate model** from two real runs:

| run | cwd | flags | sections chars | tool-schema chars | other chars | real `usage.input` |
|---|---|---|---|---|---|---|
| 1 | repo | (normal) | 32,315 | 37,704 | 615 | **16,250** |
| 2 | empty dir | `--no-skills` | 6,677 | 37,704 | 558 | **10,044** |

Solving the pair gives:
- **prose (system-prompt sections, user text, custom messages): 4.141 chars/token**
- **tool JSON schemas: 4.544 chars/token**

These reproduce run 1 to ±1 token, so the table below is tokenizer-grade in aggregate (per-component
splits are *inferred* from those two rates, not tokenized individually).

### A.1 First-turn input, by component (run 1 = real repo, full config)

| Component | Source | chars | tokens | % of 16,250 |
|---|---|---|---|---|
| `preamble` | `dist/core/system-prompt.js:80` | 169 | 41 | 0.3% |
| `<tools>` one-line snippets | `system-prompt.js:83-85` | 779 | 188 | 1.2% |
| `<rules>` | `system-prompt.js:86` / `buildRules` :29 | 2,209 | 533 | 3.3% |
| `<docs>` (Pi self-docs pointer) | `system-prompt.js:87-94` | 1,208 | 292 | 1.8% |
| `<project_context>` (2 × AGENTS.md) | `system-prompt.js:99` / `renderProjectContext` :24 | 5,432 | 1,312 | **8.1%** |
| `<skills>` catalog (61 skills) | `system-prompt.js:100-105`, `skills.js` `formatSkillsForPrompt` | 22,459 | 5,424 | **33.4%** |
| `<cwd>` | `system-prompt.js:106` | 59 | 14 | 0.1% |
| **system prompt subtotal** | | **32,315** | **7,804** | **48.0%** |
| tool schemas (18 active) | `system.toolsAdded` | 37,704 | 8,298 | **51.1%** |
| user prompt text | | 29 | 7 | 0.04% |
| moa-harness `moa-advisory` custom message | moa-harness Pi adapter | 559 | 135 | 0.8% |
| **TOTAL** | | **70,607** | **16,250** | 100% |

Nothing else is injected into the first user turn: `context_with_system` showed exactly
`[system, user(29 chars), custom(moa-advisory, 559 chars)]`.
`systemPromptOptions.sections` was `{}` and `appendSystemPrompt` was `""` — **no extension in the
current config adds a system-prompt section**. The full 8.3k "unaccounted" tokens are tool schemas.

### A.2 Tool schemas attributed to the registering package

`pi.getAllTools()` returns `sourceInfo.source`. 26 tools registered, **18 active**.

| Source package | active tools | chars | tokens |
|---|---|---|---|
| `npm:pi-subagents` | subagent, bg_wait, subagent_supervisor | 22,811 | **5,020** |
| `npm:pi-mcp-adapter` | mcp, mcpScript, mcp__browsermcp | 5,214 | 1,147 |
| `npm:pi-surf` | web_research, web_search, fetch_url | 2,814 | 619 |
| `npm:pi-schedule-prompt` | schedule_prompt | 2,387 | 525 |
| builtin | read, bash, edit, write | 2,712 | 597 |
| local (agentmemory) | memory_search, memory_save, memory_health | 856 | 188 |
| `git:…/pi-goal@v0.1.7` | create_goal | 639 | 141 |
| (per-tool wrapper / promptGuidelines) | | 271 | 60 |

**Single worst offender: `subagent` = 17,991 chars = 3,959 tokens = 24.4% of the entire initial window.**
`bg_wait` adds another 4,397 chars (968 tok). pi-subagents alone is 31% of the window.

Already-inactive-at-startup (something is already deferring these): `powershell`, `grep`, `find`, `ls`
(builtin), `get_goal`, `update_goal` (pi-goal), `plannotator_mark_done`, `plannotator_submit_plan` — 4,146 chars.

`pi-mcp-adapter` is **already JIT**: it registers one `mcp` gateway tool with
`search` / `describe` / `instructions` / `tool` actions covering 6 MCP servers, plus one namespace proxy,
instead of exposing every MCP tool schema. 3 tools / 1,147 tokens for six servers. Don't re-solve this.

### A.3 `--no-skills` and the theoretical floor

- **`--no-skills` first turn = 16,250 − 5,424 = ~10,826 tokens** (computed; run 2 measured 10,044 but from a
  different cwd that also lost the repo's `AGENTS.md`, so it is not a clean A/B).
- **Everything deferrable removed** (skills catalog + all non-builtin tool schemas + context files):
  −5,424 − 7,701 − 1,312 = **−14,437 → floor ≈ 1,813 tokens (−89%)**.
  Floor = preamble + tools/rules/docs/cwd + 4 builtin schemas + user prompt + moa block.
- Note `<skills>` is only emitted when `read` or `bash` is in `selectedTools` (`system-prompt.js:101`).

### A.4 Prompt-cache behaviour on this provider (important — changes the economics)

`cacheRead` is **not** always 0. Turn 1 of every session is a cold miss; turn 2+ read the cached prefix.
One long interactive session (session A):

```
call  1  in 17558  cacheRead     0   cost.input $0.08779  cost.cacheRead $0
call  2  in  6495  cacheRead 16896   cost.input $0.03248  cost.cacheRead $0.008448
call  3  in   440  cacheRead 23040
…
call 12  in 53162  cacheRead     0     ← full miss
call180  in193389  cacheRead 16896     ← prefix only; rest re-billed at full input rate
```

Observed rates: **input $5.00/M, cacheRead $0.50/M (10×cheaper, not free), cacheWrite always 0**
(implicit caching; `openai-responses.js:225` sends `prompt_cache_key` = session id, no `cache_control`).
`cacheRead` is quantized to 1024-token blocks.

Aggregate over that 210-call session: **4,551,735 billed input tokens, 34,109,952 cacheRead tokens,
9 calls with `cacheRead == 0`, 11 more with `cacheRead < 20k`, $52.92 total.**

**Economic consequence of shrinking the static prefix by ~12k tokens:**
- 190 cache-hit calls × 12k × $0.50/M = **$1.14**
- 20 miss/partial-miss calls × 12k × $5.00/M = **$1.20**
- ≈ **$2.34 of $52.92 ≈ 4.4%** on a long interactive session.

So for *long sessions* the win is ~4%, not 70%. The real wins are elsewhere:
1. **One-shot / print-mode / subagent runs pay the full 16,250 every time** — `pi -p` benchmark arms,
   `pi-subagents` children, moa advisor children. There the cut is the headline −70%.
2. **Compaction deferral**: 12k fewer resident tokens delays every compaction (each compaction is a
   full-transcript summarization call).
3. **Tool-choice quality** — the speaker's actual claim; unmeasured here.

---

## B. Pi extension API surface for JIT injection

### B.1 `before_agent_start`

`dist/core/extensions/types.d.ts:554-565`:
```ts
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;                                   // ← raw user prompt, after expansion
  images?: ImageContent[];
  readonly systemPrompt: string;                    // getter, re-renders on each read
  systemPromptOptions: NormalizedBuildSystemPromptOptions;   // ← MUTABLE
}
```
Result (`types.d.ts:917-921`): `{ message?: CustomMessage-ish, systemPrompt?: string }`.

- **Sees the user's prompt?** Yes — `event.prompt`.
- **Sees the resolved skill list?** Yes — `systemPromptOptions.skills: Skill[]`, a *deep copy*
  (`system-prompt.js:21`) that is mutable and re-read after all handlers. Probe confirmed 61 entries with
  name/description/path. **Filtering that array is how you filter the `<available_skills>` catalog.**
- **Can it replace the system prompt?**
  - *Whole string*: return `{ systemPrompt }` → stored as `forceSystemPrompt` (`runner.js:1038-1040`).
    **Do not use.** `_installAgentForcedPromptProjection` (`agent-session.js:1044-1059`) collapses *all*
    system messages into one head carrying the forced text on every request → the cached prefix is
    rewritten every turn.
  - *Named sections*: mutate `systemPromptOptions.sections` (a `Record<tag, text>`). These are appended
    **after** `cwd`, i.e. at the end (`system-prompt.js:110-113`). Name must match `/^[a-z][a-z0-9_-]*$/`
    and must not be `preamble` (`system-prompt.js:70-74`).
  - Also mutable: `contextFiles`, `skills`, `selectedTools`, `appendSystemPrompt`, `promptGuidelines`,
    `toolSnippets`, `toolGuidelines`, `customPrompt`.
- **Tool set before the first request**: mutate `systemPromptOptions.selectedTools` in place.
  `agent-session.js:1283-1290`: *"Handlers may edit event.systemPromptOptions.selectedTools or call
  setActiveTools() … An explicit edit wins; otherwise the live loadout is authoritative."*
- **Async?** Yes — `await handler(event, ctx)` (`runner.js:1037`), handlers run sequentially in
  extension-load order. A retrieval step with a timeout fits here.
- Handler errors are caught and reported; the run continues (`runner.js:1046-1055`) — fail-open is free.

### B.2 `context` / `context_with_system`

`types.d.ts:514-533`, `:880-882`, registration at `:991-992`.
- `context`: fires before **each** LLM call; `messages` excludes system messages; returning
  `{ messages }` rewrites the array. Pi restores prompt/tool state afterwards, so a `context` handler
  **cannot** alter the system prompt or tools (`docs/extensions.md:107`).
- `context_with_system`: same timing, after `context`; `messages` is the *full* transcript including
  system messages and `toolsAdded`. The returned array is sent **as-is** — "the handler owns the prompt
  and tool declarations" (`types.d.ts:525-529`). So per-call system-prompt and tool mutation *is*
  possible here, but it bypasses the transcript-delta machinery entirely (nothing is recorded) and is the
  most cache-hostile option. `pi-observational-memory` uses the `context` family for message rewriting.

### B.3 Dynamic tools

- `pi.getAllTools(): ToolInfo[]` (`types.d.ts:1072`, `:1279-1281`) — name, description, parameters,
  promptGuidelines, **`sourceInfo`** (package attribution).
- `pi.getActiveTools(): string[]` (`:1070`), **`pi.setActiveTools(names: string[]): void`** (`:1074`).
- Official pattern, `docs/extensions.md:140-144`: *"Register every tool first, keep optional tools
  inactive, and use `pi.setActiveTools()` from a loader tool to select the desired active tools. Names
  must already be registered; unknown names are ignored."* Example: `examples/extensions/dynamic-tools.ts`.
- There is **no** `toolsOverride`; `setActiveTools` is the whole API. An extension cannot un-register a
  tool another extension registered — only deactivate it.
- Tool deltas become `toolsAdded` / `toolsRemoved` on a system message inserted before the next request
  (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:209-245`).
- `pi-mcp-adapter` is already on-demand (see A.2); no change needed there.

### B.4 `skillsOverride` / `agentsFilesOverride` / `systemPromptOverride`

`dist/core/resource-loader.d.ts:84-118` — these live on `DefaultResourceLoaderOptions`, consumed at
`resource-loader.js:513` etc. They are **SDK-only**: constructed by the embedder of `DefaultResourceLoader`
(see `docs/sdk.md`), never exposed on `ExtensionAPI`. An extension cannot reach them.
The extension-visible equivalents are `resources_discover` (paths only, startup/reload only) and
`systemPromptOptions.skills` / `.contextFiles` (per-run, and what pi-jev should use).

### B.5 Existing skill-routing / hiding mechanisms

- **None per-prompt.** `resources_discover` (`types.d.ts:405-415`) lets an extension *add* `skillPaths`,
  `promptPaths`, `themePaths` at `reason: "startup" | "reload"` — additive, no filtering, not per-prompt.
- `disable-model-invocation: true` in SKILL.md frontmatter: the skill is **excluded from the
  `<available_skills>` catalog** and reachable only via the explicit `/skill:name` command
  (`docs/skills.md:53`, `docs/skills.md:79`). That is a *static*, per-skill opt-out — a blunt manual
  version of what pi-jev automates. No routing, no scoring, nothing prompt-dependent.
- Pi *already* does one level of progressive disclosure: catalog only (name + description + path); the
  model `read`s SKILL.md on demand (`docs/skills.md:43-45`). pi-jev is a second level on top.

### B.6 Where retrieval can run / what's available in-process

- **`before_agent_start`** — awaited, has `prompt` + `skills` + `getAllTools()`. Primary site.
- **`input`** (`types.d.ts:723-743`) — fires earlier, on user input, awaited, can transform the text.
  `moa-harness` uses exactly this as a preflight to start async work early and cache the result for
  `before_agent_start` (its Pi adapter). Same trick works
  here. Caveat: moa gates it to TUI mode; verify it fires in `-p` print mode before relying on it.
- **Nested model calls**: `ctx.modelRegistry.streamSimple()` (`docs/extensions.md:153`), or
  `complete` / `completeSimple` from `@earendil-works/pi-ai/compat` with
  `ctx.modelRegistry.getApiKeyAndHeaders` — the pattern `pi-observational-memory` uses.
- **Embeddings**: `@earendil-works/pi-ai` exposes **no** embeddings API (grep for `embeddings` across its
  `.d.ts` → nothing). Options are shelling out or using a chat model. The local shell-out option is
  fastembed (`BAAI/bge-small-en-v1.5`, no service), which has a **30-60 s cold start**, which kills it for
  a sub-second budget. There is **no BM25 implementation anywhere in the repo** (verified: no
  `bm25|okapi|rank_bm25|tfidf|fts5` hits outside prose).

### B.7 Prompt-cache implications per injection strategy (the decisive section)

| Strategy | Mechanism | Prefix impact |
|---|---|---|
| Return `{ systemPrompt }` from `before_agent_start` | `forceSystemPrompt` → all system messages collapse into one head (`agent-session.js:1044-1059`) | **Rewrites the prefix every turn. Never do this.** |
| Mutate `systemPromptOptions.sections` / `.skills` / `.contextFiles` | `diffSystemPromptSections` (`system-prompt.js:135`) → only changed sections, emitted as a **new system message appended mid-transcript** (`agent-session.js:1031`) | **Prefix untouched.** Turn-1 filtering is free; later re-filtering costs only the delta. This is Pi's built-in equivalent of agent-native's zero-width-sentinel "volatile tail", and strictly better (positional-in-transcript, not positional-in-string). |
| Append to the first user message / `sendMessage` custom | ordinary conversation content | Prefix untouched. |
| `setActiveTools` / edit `selectedTools` **on this user's model** | `resolveTranscriptTools` (`pi-ai/dist/utils/transcript.js:194-201`) | **Busts the whole prefix.** See below. |
| `setActiveTools` on a model with `compat.supportsAdditionalTools` | additions ride as an `additional_tools` developer item (`pi-ai/dist/api/openai-responses-shared.js:93-102`) or Anthropic `tool_addition` blocks; top-level `tools` array stays pinned to the initial set | Prefix safe **while purely additive**. |
| Any tool **removal** or same-name redeclaration | `hasNonAdditiveToolChanges` (`transcript.js:173-186`) → `anchorsAdditions = false` → full current tool list resent at top level | **Prefix bust.** |

**The gotcha for this user specifically:** `~/.pi/agent/models.json` defines `gpt-5.6-sol` (and
`-terra`, `-luna`) with **no `compat` block at all** → `supportsAdditionalTools = false` and
`supportsToolSearch = false` (`pi-ai/dist/api/openai-codex-responses.js:376-384`). So on the user's
default model *every* tool-set change resends the full `tools` array and misses the prefix cache from
token 0. `models-store.json` shows other GPT-5.6 entries that *do* carry
`compat.supportsAdditionalTools: true` + `supportsToolSearch: true`, so the capability exists — the
codex-subscription entry just doesn't declare it. (*Inferred*: flipping it on would make additive
tool loading cache-safe; untested against the live endpoint.)

Anthropic providers place `cache_control` on the last tool (`anthropic-messages.js:1177`), on
`initialSystemText` (`:823-840`), and a rolling breakpoint on the last user/system message
(`:1107-1127`) — same conclusion: additive-only is safe, removal is not.

---

## C. Preliminary port design — `pi-jev`

Shaped by the sibling reports: Jev is TypeSafe's "System One" chooser (finite option set + per-option
probabilities, `@typesafe-ai/sdk`, `jev-latest`), used by BuilderIO/agent-native once per user POST,
top-3 (max 5), additive-only, 750 ms / 0 retries / fail-open, 128-candidate cap with a lexical shortlist.
No benchmarks published anywhere; the one number ("~60-70% system prompt reduction") is uncited.

### C.1 What changes in the initial window

| Slice | Now | Under pi-jev | Δ tokens |
|---|---|---|---|
| `<skills>` catalog, 61 entries | 5,424 | top-5 full entries (~444) + names-only line for the other 56 (~295) = **739** | **−4,685** |
| tool schemas, 18 active | 8,298 | base {read,bash,edit,write,mcp,memory_search} = 1,427 + top-3 selected ≈ 264 = **1,691** | **−6,607** typical |
| ″ worst case (`subagent` selected) | 8,298 | 1,427 + 3,959 + ~250 = **5,636** | −2,662 |
| `<project_context>` (AGENTS.md ×2) | 1,312 | **keep** — repo policy the model must not miss | 0 |
| everything else | 1,216 | 1,216 | 0 |
| **first-turn total** | **16,250** | **≈ 4,950** | **−70%** |

Independently of any ranker, a **zero-risk baseline** is available: truncate every skill description to
~100 chars in the catalog (61 × ~140 chars = 2,062 tok) → **−3,362 tokens, no skill ever hidden,
no ranker, ~20 lines**. Ship that first; it is most of the skills win with none of the risk.

### C.2 Shape of the extension

One file, `~/.pi/agent/extensions/pi-jev.ts` (dev: `pi -e ./pi-jev.ts`). Three hooks, one pluggable
function.

```
rank(prompt, candidates: {id, kind, name, description}[]) -> {id, score}[]        // THE seam
```

1. **`input`** (optional, TUI/RPC only) — kick `rank()` off early, cache by prompt hash. Copy
   moa-harness's preflight pattern (its Pi adapter).
2. **`before_agent_start`** — the whole mechanism:
   - build candidates from `event.systemPromptOptions.skills` (61) + `pi.getAllTools()` (26);
   - `await Promise.race([rank(...), timeout(750)])`; on timeout/throw → leave everything untouched
     (fail-open, "an accelerator, not a dependency");
   - **skills**: replace `systemPromptOptions.skills` with the top-k (k=5), and push the remaining
     names as a one-line `sections.skills_index` so nothing is invisible;
   - **tools**: `systemPromptOptions.selectedTools = [...BASE, ...top3]` — the in-place edit wins
     (`agent-session.js:1283-1290`).
3. **`tool_result`** — mid-loop expansion. Pi already has the deterministic escape hatch agent-native
   hand-rolled: the `mcp` gateway (`search`/`describe`) for MCP, and for Pi-native tools a tiny
   `tool_search` tool registered by pi-jev whose `execute()` calls `pi.setActiveTools([...current, ...hits])`
   and returns the schemas inline. **Cheaper alternative for this user:** return the full schema *text*
   in the tool result and skip `setActiveTools` entirely — on `gpt-5.6-sol` a registry mutation costs a
   full cache miss (B.7), a tool-result text block costs nothing.

### C.3 Cache-safety rules baked in

- Never return `{ systemPrompt }`. Only mutate `sections` / `skills` / `contextFiles`.
- Run tool selection **once per session** (first prompt), not once per user message, until
  `compat.supportsAdditionalTools` is confirmed working for `openai-codex`. Jev's per-POST cadence would
  cost one full-transcript re-read per user message here (~$0.25 at 50k context).
- Tool set is a **one-way ratchet**: only ever add, never remove (`transcript.js:173-186`).
- Skills re-filtering per prompt *is* safe at any cadence — it rides the section delta.

### C.4 Ranker choice, cheapest first

1. **Hand-rolled weighted token overlap** over `name` (×3) + `description` (×1), stopword-stripped, zero
   deps, sub-millisecond — exactly agent-native's `agent/tool-search.ts:97-252`. **Start here.** No BM25
   exists in the repo to reuse (subagent verified).
2. **Tiny classifier call** — `ctx.modelRegistry.streamSimple()` or `pi-ai/compat.completeSimple` with
   `gpt-5.4-mini` via litellm (the user already configures that model for observational-memory). ~200 ms,
   real cost, better recall on paraphrase.
3. **Jev itself** — `@typesafe-ai/sdk`, `jev-latest`, one `choice` question over ≤128 candidates.
   Same interface as (1); drop-in behind `rank()`.

Embeddings are the wrong rung: pi-ai has none, and the only local embedder (fastembed) has a 30-60 s cold start vs. a 750 ms budget.

### C.5 Reuse from the user's repo

- **moa-harness `bench/run.py --host pi`** is already the right rig: `run.py:252-269` builds
  `pi -p [--session-dir|--no-session] --no-extensions --no-context-files --no-skills
  --no-prompt-templates --no-themes [-e EXT] --provider P --model M PROMPT`, arm-switched via `-e`.
  **Gap:** it measures wall clock only (`run.py:647-651`); `bench/score.py:307-321` has a literal
  `"TODO: sum main-model tokens x rate"` placeholder. Fix = always pass `--session-dir` and sum
  `usage.input`, `usage.cacheRead`, `usage.cost.total` from the session `.jsonl` — ~15 lines, and it
  makes *this* project measurable. Note the bench currently disables skills/extensions, so a pi-jev arm
  needs a third mode that re-enables them (that's the whole point of the comparison).
- **`pi-harness/extensions/pi-extension-loader`** already does `getAllTools` / `setActiveTools` gating
  and blocks disabled tools via `tool_call` → `{block:true}` . Its
  ids are hardcoded, so it is a *reference implementation*, not a host: write pi-jev
  standalone and copy the gating idiom.
- **moa-harness's Pi adapter** is the reference for the `input`→`before_agent_start`
  preflight-and-cache pattern and for returning `{ message }` from `before_agent_start`.

### C.6 Benchmark plan

Three arms on the same SWE-bench-Lite-20 set already in `bench/tasks/lite-20.json`:
`off` (current full window) / `trunc` (C.1 zero-risk baseline) / `jev` (full ranker).
Metrics per task: first-turn `usage.input`, session `usage.input` + `cacheRead` + `cost.total`, wall
clock, and pass rate. The honest hypothesis to test, given A.4: **cost win is large for one-shot runs
and small (~4%) for long sessions; the thing actually worth measuring is whether pass rate holds.**

---

## Marked inferences

- Per-component token splits in A.1/A.2 come from the two-rate calibration, not per-string tokenization;
  the aggregate is exact, the splits are ±2%.
- `--no-skills` = 10,826 tokens is computed, not measured in the repo cwd (run 2 changed cwd).
- Setting `compat.supportsAdditionalTools: true` on the codex `gpt-5.6-sol` entry would make additive tool
  loading cache-safe — inferred from `openai-responses-shared.js:93-102` and the presence of that flag on
  sibling GPT-5.6 entries in `models-store.json`; not tested against the live endpoint.
- The 4.4%-of-session-cost figure extrapolates one 210-call session; cache-miss frequency will vary.
