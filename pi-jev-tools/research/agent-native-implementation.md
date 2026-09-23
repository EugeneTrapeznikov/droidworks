# BuilderIO/agent-native — how Jev-based context selection is implemented

Source: `github.com/BuilderIO/agent-native` @ `1bc60c1` (`@agent-native/core` v0.184.0). Line refs are into that commit under `packages/core/src/`.

## What "Jev" is

Not an acronym. `Jev` is TypeSafe AI's "System One" model: a non-generative transformer that takes a `state` plus typed `questions` (Choice / Score) and returns typed answers with calibrated probabilities. Called via `@typesafe-ai/sdk@0.6.0` `client.systemOne(...)`, model alias `jev-latest`, or via Builder's proxy `/agent-native/jev/v1/system-one`. Repo budgets it at a 750 ms hard timeout (`agent/jev-tool-prefetch.ts:10`).

In-repo definition (`onboarding/app-profile.ts:14-22`): "Jev is an optional decision model that helps choose relevant tools and skills before the agent's first model request."

Jev is an accelerator layered on a deterministic JIT system, not the system itself. The canonical repo terms for the technique are `lazyContext` (`agent-chat/plugin-options.ts:291-305`), `deferLoading` / `initialToolNames` (`server/agent-chat/production-agent.ts:992-998`), `tool-search` (`agent/tool-search.ts`) and "progressive disclosure". README makes no claims; changelog has two lines (`CHANGELOG.md:89,108`).

## Trigger points

Jev fires once per user message (per HTTP POST to the agent-chat handler), before the first model call of that run. Never on later model turns, never on tool results, never for subagents.

```ts
// production-agent.ts:10683-10701
const [requestTools, jevContext] = await Promise.all([
  preloadJevTools({ request: requestMessage, ... }),          // tool schemas
  preloadJevContextForPrompt({ request: requestMessage, ... }) // skill bodies
]);
if (jevContext) systemPrompt = `${systemPrompt}\n\n${jevContext}`;
```

| # | Trigger | Mechanism | Code |
|---|---|---|---|
| 1 | User prompt submit | Jev ranks skills, inlines bodies into system-prompt tail | `production-agent.ts:10694-10701`, `agent-chat/prompt-resources.ts:927-996` |
| 2 | User prompt submit | Jev ranks deferred tools, prepends ≤3 (max 5) schemas | `production-agent.ts:10684-10693`, `jev-tool-prefetch.ts:188-254` |
| 3 | User prompt submit, Plan mode | deterministic lexical rank, top 3 read-only tools, no Jev | `production-agent.ts:3897-3930` |
| 4 | Tool result of `tool-search` (mid-run) | result names' schemas added to `activeTools` for the next request | `production-agent.ts:7459-7467` |
| 5 | Run start / resume | replays #4 from prior `tool-search` results in history | `production-agent.ts:5282`, `:3993-4013` |
| 6 | Model calls `docs-search` / `resources` / `get-framework-context` | ordinary tool call returning skill body / docs | `agent-chat/context-tools.ts:23+` |

No Claude Code hooks are used for this. `.claude/settings.json` only has a file-lease PreToolUse/PostToolUse guard. Subagents get deterministic deferral only (`server/agent-teams.ts:1795-1807`).

## Selection mechanism (three layers)

1. Deterministic allow-list: `filterInitialEngineTools` (`production-agent.ts:3883-3896`) keeps `initialToolNames` ∪ `tool-search` ∪ 8 universal tools (`:3949-3969`).
2. Hand-rolled weighted substring scorer, no library: `scoreTool` (`tool-search.ts:372-415`). Phrase hits: name +14, source +10, description +8, params +5. Token hits: name word +9 / substring +6, source +6/+3, description +3, params +2, anywhere +1. Drop if score ≤ 0. Default limit 8, max 25. Same idea (naive token overlap) shortlists to 128 candidates before Jev (`jev-tool-prefetch.ts:144-169`, marked `ponytail:`).
3. Jev: one `choice` question over candidates `{id, description(≤180 chars), kind}`; sort by probability, force `answer.choice` to rank 1, top-k cut only, no probability threshold (`jev-tool-prefetch.ts:76-134`). `DEFAULT_PREFETCH_LIMIT = 3`, `MAX_PREFETCH_LIMIT = 5`. Single candidate short-circuits without a call.

Privacy gate: SQL/workspace resource names never go to Jev (`prompt-resources.ts:875-878`); only bundled skills are candidates.

## Initial window: removed vs kept

Removed under `lazyContext: true` (default): all tool schemas except initial + universal + `tool-search`; SQL schema block; verbose framework prose; full skill bodies; workspace inventory; every resource sliced to 6,000 chars.

Kept as index: `<skills-summary>` with name + ≤180-char one-liner + the retrieval command, capped at 40 entries plus an overflow line (`prompt-resources.ts:1090-1106`). Tools have no catalog in the prompt at all: `tool-search` with an empty query returns the catalog as a tool result (`tool-search.ts:110-115`).

Injected payloads: Jev skills = full SKILL.md bodies wrapped in `<jev-prefetched-context>` appended to the end of the system prompt, 10k chars/item, 24k total (compact 6k/16k), fence-escaped against injection (`prompt-resources.ts:160-169`). Jev tools = full schemas prepended to the tool array (`jev-tool-prefetch.ts:360-368`). `tool-search` can also return full `inputSchema` in the result text (`includeSchemas: true`, `tool-search.ts:221`), needing no registry mutation.

## State and caching

- Per-run dedupe of `tool-search` queries in `RunContext.toolSearchReads` (`server/request-context.ts:147-155`); a repeat returns names only plus a warning.
- `activeToolNames: Set` guards re-adding; `expandedToolSchemaBytes` warns past 32k (`production-agent.ts:5221-5277`).
- No persistent cache of Jev decisions.
- Prompt cache: a zero-width sentinel `​` splits the system prompt into stable prefix (with `cache_control`) and volatile tail (`agent/engine/prompt-cache.ts:8`, `anthropic-engine.ts:170-175`). Jev block goes at the very end, so it never busts the stable prefix.
- Inferred weakness: Jev-selected tools are prepended to the tool array and `cache_control` sits on the last tool; tools precede system in Anthropic's cache order, so a changed tool array likely invalidates everything after it.

## Measurements

None. No token-savings benchmark, no eval. What exists: first-request char telemetry (`production-agent.ts:3932-3947`), a CI guard capping starter tools at 40 and instructions at 6,000 chars (`scripts/guard-agent-chat-context.ts`), Context X-Ray runtime observability (real tokenizer optional, chars/4 fallback), unit tests on behaviour. One uncited doc claim: "reduces the system prompt by ~60-70%" (`plugin-options.ts:298-300`).

## Footprint

TypeScript, ~800 lines across three files. Only dependency for Jev is `@typesafe-ai/sdk`, lazily imported only on the direct-key path; proxy path is plain `fetch`. `tool-search` has zero deps. No daemon, no index build, no embeddings. Everything fails open to the deterministic path.

## Weaknesses seen in code

- 128-candidate cap with naive substring shortlist (two `ponytail:` markers).
- No probability threshold; top-3 taken even when uncertain, up to 10 KB each.
- 750 ms Jev call on the critical path of every user message.
- Tool-array reordering vs prompt cache (inferred).
- User-specific resources excluded from ranking for privacy, so the most relevant context is the one Jev cannot rank.
- Hard char slicing silently dropped 39% of one AGENTS.md before the CI guard existed (`guard-agent-chat-context.ts:7-11`).
- `BUILDER_JEV_PROXY_ENABLED = true` is a hardcoded const.
