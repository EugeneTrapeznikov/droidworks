# local-judge

A loopback sidecar that speaks TypeSafe's System One HTTP shape, so the
extension's `local` judge backend works against it unchanged.

```
POST http://127.0.0.1:47411/v1/systemone
  {model?, state, questions: {id: {type: "choice"|"noul"|"score", instructions, criteria?}}}
->
  {answers: {id: {choice, probabilities, confidence}
                | {probability}
                | {level, probabilities}},
   usage: {input_tokens}, latencyMs, backend}

GET  http://127.0.0.1:47411/healthz  -> {status, engine, model}
```

Numbers, the candidate survey and the negative results are in
[RESULTS.md](RESULTS.md).

## Install

```bash
cd pi-jev-tools/local-judge
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python mlx-lm          # logprob engine
uv pip install --python .venv/bin/python sentence-transformers   # reranker engine only
```

`.venv/` is gitignored. The `kev` engine needs no Python deps here at all — it
talks HTTP to a separate `kev.serve` process.

## Run

### Default engine: kev (best accuracy, best calibration, 39 ms p50)

`--engine kev` is the `server.py` default; the flag below is explicit only so
the command reads as one piece.

Two processes. First [kev](https://github.com/jaredpalmer/kev) itself, cloned
anywhere:

```bash
git clone https://github.com/jaredpalmer/kev.git && cd kev
uv sync --extra serve
KEV_TEMPERATURE=1.3 uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
```

It picks MLX automatically on Apple Silicon. `KEV_TEMPERATURE=1.3` overrides the
shipped 2.41, which is underconfident on agent-routing questions (RESULTS.md §4).

Then the sidecar, which translates kev's `{noul}` / `{score, legend}` answers
into the `{probability}` / `{level, probabilities}` the extension expects:

```bash
uv run --python .venv/bin/python server.py --engine kev --model http://127.0.0.1:8009
```

### One process, no torch: logprob on a generic MLX model

```bash
uv run --python .venv/bin/python server.py \
  --engine logprob --model mlx-community/Qwen3-4B-4bit --no-calibrate --temp 6
```

Renders each question as a prompt ending in `Answer:` with single-token option
labels, runs one forward pass, and softmaxes the next-token logits over the
allowed labels. All questions in a request share one KV-cache prefill of
`state`. Use `--model mlx-community/Qwen3-1.7B-4bit --temp 3` (keeping
calibration on) if you want half the RAM and half the latency for ~5 points of
accuracy.

### Reranker

```bash
uv run --python .venv/bin/python server.py --engine reranker --model BAAI/bge-reranker-v2-m3
```

Measured worse than everything else on tool routing (0.200). Kept because it is
the cheapest thing that can pre-filter a large skill catalog.

### Remote endpoint: JevK5 on another machine

`--engine kev` forwards to any `/v1/systemone` server at `--model <url>`, including
[JevK5](https://github.com/allebee/jevk5)'s `jevk5-serve` running on a GPU box.
`jevk5-serve` binds 127.0.0.1 and has no auth, so tunnel to it:

```bash
# on the GPU box
jevk5-serve --model alibiserikbay/JevK5 --port 8090
# on the laptop
ssh -N -L 8090:localhost:8090 <gpu-host> &
uv run --python .venv/bin/python server.py --engine kev --model http://127.0.0.1:8090 \
  --template jevk5 --max-options 16 --port 47412
```

Ports: 47411 is the kev sidecar, 47412 the JevK5 sidecar; point `PI_JEV_LOCAL_URL`
at whichever one you want. JevK5 reads letters A–P only, so `--template jevk5`
refuses more than 16 options with a 400 before forwarding, and `--max-options 16`
first cuts each choice to a lexical top 16 (always keeping `none`). Options it
drops come back at probability 0. The sidecar maps JevK5's `"0"`, `"1"`, …
score keys back to the level text, and falls back from `/v1/models` to
`/health` at startup. Latency includes the tunnel round trip. Eval over the
tunnel: `eval.py --engine kev --model http://127.0.0.1:8090 --template jevk5 --max-options 16`.

### kev (dropped 2026-09-23)

Served alongside JevK5 on the same GPU host (sidecar port 47411). Dropped: replay AUC 0.509 with the winnow question, below the
token-overlap baseline (AUC 0.672).

The first kev request after a server start takes about 90 s while Triton compiles the
flash-linear-attention kernels.

### Self-check

```bash
uv run --python .venv/bin/python server.py --demo            # asserts one choice, noul and score
uv run --python .venv/bin/python test_remote.py              # remote-endpoint proxy, fake servers, no model
uv run --python .venv/bin/python eval.py --engine kev        # 60-item local set
```

`eval.py` writes the set it built to `eval.jsonl` and appends a summary plus
per-item rows to `results.jsonl`.

## Wiring the extension

```bash
export PI_JEV_JUDGE=local
export PI_JEV_LOCAL_URL=http://127.0.0.1:47411
```

`bench/swe/arms.json` already points its `*-local` arms at port 47411.

## Limits

- **`--engine logprob` caps out at 62 options** (labels A–Z, a–z, 0–9 — one
  token each). Jev allows 255 and the real Pi catalog is 76 skills, so the
  logprob engine needs a pre-filter before it can serve the full catalog.
  `--engine kev` (the default) has no such limit. An over-limit request is
  refused with `400 {"error": "engine 'logprob' cannot serve N options …"}` —
  the option list is never silently truncated.
- **750 ms is tight at full catalog size.** A three-question request over 76
  skills with full descriptions measures p50 678 ms / p95 817 ms. Truncating
  option descriptions to 100 characters takes it to p50 332 / p95 489.
  Descriptions, not `state`, dominate the cost. The extension's knob for this
  is `PI_JEV_DESC_CHARS` (default 120).
- **kev caps each question at 8,192 tokens, state included.** Over that it
  answers `422 {"detail": "branch too long: N tokens with an M-token state (row
  limit 8192)"}`, which the sidecar passes through as a 500. Chunking a request
  into more questions does not help; the limit is per question, not per request.
- **Put what varies in `state`, not in `instructions`.** Question text is
  re-prefilled per question by both engines, and varying `instructions` also
  misses the logprob engine's calibration-prior cache.
- `timeoutMs` in the request body is accepted and ignored.
- The server binds 127.0.0.1 only and has no auth. It serves one model; restart
  to change engines. `kev.serve` handles one request at a time.
- Probabilities are calibrated only as well as the fitted temperature, and both
  temperatures in the commands above were fitted on the 60-item set they are
  scored on.
