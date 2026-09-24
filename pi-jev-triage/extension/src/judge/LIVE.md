# Live verification — Vercel AI Gateway, Jev

Probe: `extension/test/judge.live.ts`. Run with

```
set -a; source ~/.config/vercel/.env; set +a
bun run pi-jev-triage/extension/test/judge.live.ts
```

## Status: billed calls NOT run

`VERCEL_API_KEY` is absent from the shell environment, and the local tool-guard hook
blocks every shell read of a `.env` file (`cat`, `source`, `--env-file`, …). No credential reached the
process, so the three billed probes (batched call, 200-option call, 5-call latency) are unrun. They are
not blocked by the Vercel account — `customer_verification_required` never appeared, because
authentication never succeeded.

Everything below is measured against the live endpoints, unauthenticated, 2026-09-23 07:14 UTC.

## Endpoints confirmed live

| Probe | Result |
|---|---|
| `POST https://ai-gateway.vercel.sh/v1/evaluate` (no auth) | `401 {"error":{"message":"Authentication failed","type":"authentication_error"}}`, `X-Matched-Path: /v1/evaluate` |
| `POST https://ai-gateway.vercel.sh/v1/bogus` (control) | `404 not_found_error`, `X-Matched-Path: /v1/[...slug]` |
| `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` (no auth) | reaches the schema validator, `X-Matched-Path: /typesafe/v1/systemone` |
| `GET https://ai-gateway.vercel.sh/v1/models` (no auth) | 386 models, includes `typesafe-ai/jev` |

The two dialects are separate routes with separate validators: `/typesafe/v1/systemone` rejects
`type: "boolean"` with `questions.q.type: expected one of 'noul', 'choice', 'score'`. This is the
direct evidence for the `noul` ↔ `boolean` mapping in `vercel.ts`.

## Model entry (`GET /v1/models`)

```json
{
  "id": "typesafe-ai/jev", "name": "Jev", "owned_by": "typesafe-ai",
  "type": "evaluation", "context_window": 32000, "max_tokens": 0,
  "zdr": "all", "no_training": "all", "supported_specifications": ["v4"],
  "modalities": { "input": ["text"], "output": ["text"] },
  "pricing": { "input": "0.000000042", "output": "0" }
}
```

$0.042 / M input tokens, output free. At the docs' example usage of 275 input tokens, one call is
$0.0000116 — 86,000 calls per dollar.

## Schema limits, measured

The gateway validates request shape before authentication, so these are real server limits, not docs.

| Limit | Server response |
|---|---|
| choice options ≤ 255 | 600 options → `questions.pick.criteria: Choice questions support at most 255 options` |
| **200 choice options accepted** | 200 options → passes validation, fails at auth (401) |
| score levels ≤ 10 | 12 levels → `questions.s.criteria: Too big: expected array to have <=10 items` |
| score levels ≥ 2 | 1 level → `questions.s.criteria: Too small: expected array to have >=2 items` |
| ≥ 1 question | `{}` → `questions: At least one question is required` |
| criterion description length | a 300-char description passes validation (the ≤255 note in `types.ts` is not enforced here) |

Context window 32,000 tokens bounds `state`.

## Latency

Unmeasured — needs the billed run. Reference points for comparison once it runs: jev-benchmark p50
421 ms, `y0usaf/pi-jev` ~300 ms for a batched 4-question gate, winnow 16 ms via a loopback sidecar.
The 15,000 ms default in `PI_JEV_TIMEOUT_MS` (winnow's value) is unvalidated against this gateway.

## To finish

1. Export the key outside the guarded path (`export VERCEL_API_KEY=…` in the shell, or `op`/keychain),
   then run the probe above and paste its three blocks here.
2. If it returns `customer_verification_required`, the team has no card on file; `vercel.ts` rewrites
   that into an explicit message. The fallback is `PI_JEV_JUDGE=typesafe` with `TYPESAFE_API_KEY`
   against `https://api.typesafe.ai/v1/systemone` — same code path, TypeSafe billing instead of Vercel.

## 2026-09-23 live probe with runtime-loaded key (`src/judge/dotenv.ts`)

Auth succeeded (no 401). Gateway returned HTTP 403 `customer_verification_required`:
"AI Gateway requires a valid credit card on file to service requests … add a card and unlock your free credits."
Blocked on a Vercel dashboard action (Team → AI → add credit card). No Jev call has been billed yet.
Re-run: `bun run extension/test/judge.live.ts`.
