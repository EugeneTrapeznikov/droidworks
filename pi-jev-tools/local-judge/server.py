#!/usr/bin/env python3
"""Local System One sidecar. Speaks TypeSafe's /v1/systemone shape so the Pi
extension's `local` judge backend works unchanged.

    POST /v1/systemone  {model?, state, questions}  -> {answers, usage}
    GET  /healthz                                   -> {status, engine, model}

Engines:
  kev       proxy to a running `kev.serve`.  Default: best accuracy and
            calibration, and no ceiling on the number of options.
  logprob   one prefill of `state` on a small MLX instruct model, then one short
            forward per question over a shared KV cache; softmax the next-token
            logits over the allowed label tokens.  Capped at 62 options.
  reranker  cross-encoder relevance scores (sentence-transformers, torch MPS).

A question an engine cannot serve (too many options for its label alphabet) is
a 400 with an explicit message, never a silently truncated option list.
"""

import argparse, copy, json, math, os, re, string, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# A/B/C.. then a/b/c.. then 0-9: 62 labels that are single tokens in every BPE
# vocab we care about.
# ponytail: 62-option ceiling. Jev allows 255. Above 62 you need multi-token
# labels (one forward pass per label) or a lexical pre-filter to the top 62.
LABELS = string.ascii_uppercase + string.ascii_lowercase + string.digits

# JevK5 (github.com/allebee/jevk5, runtime.py): SemIf's prompt, the decision as
# JSON, letters A-P only, bare letter read right after the chat template.
JEVK5_LETTERS = "ABCDEFGHIJKLMNOP"
JEVK5_SYSTEM = (
    "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. "
    "Respond with only its uppercase letter, with no explanation or reasoning."
)


class OptionLimit(ValueError):
    """This engine cannot address that many options. Refusing beats truncating:
    a silently dropped option looks like a confident 'not this one'."""


def confidence(probs):
    """TypeSafe's derived confidence: (n*pmax - 1) / (n - 1)."""
    n = len(probs)
    if n < 2:
        return 1.0
    return max(0.0, (n * max(probs.values()) - 1.0) / (n - 1))


def render(state, q, template="plain"):
    """-> (system_text, user_text, labels, keys). labels[i] answers keys[i]."""
    if template == "jevk5":
        return render_jevk5(state, q)
    if q["type"] == "noul":
        labels, keys = ["yes", "no"], ["yes", "no"]
        opts = "yes\nno"
    else:
        if q["type"] == "choice":
            keys = list(q["criteria"].keys())
            descs = [f"{k}: {v}" for k, v in q["criteria"].items()]
        else:  # score
            keys = descs = list(q["criteria"])
        if len(keys) > len(LABELS):
            raise OptionLimit(
                f"engine 'logprob' cannot serve {len(keys)} options (limit {len(LABELS)}: "
                f"one single-token label each). Use --engine kev, which has no limit."
            )
        labels = list(LABELS[: len(keys)])
        opts = "\n".join(f"{l}. {d}" for l, d in zip(labels, descs))

    state_text = state if isinstance(state, str) else json.dumps(state, indent=1)
    system = "Answer questions about the STATE by picking exactly one option.\n\nSTATE:\n" + state_text
    user = f"{q['instructions']}\n\nOptions:\n{opts}\n\nReply with exactly one option label."
    return system, user, labels, keys


def render_jevk5(state, q):
    """JevK5's decision_options() + messages(): noul -> true/false, options "key: description"."""
    if q["type"] == "noul":
        keys, descs = ["yes", "no"], ["true: The proposition is true.", "false: The proposition is false."]
    elif q["type"] == "choice":
        keys = list(q["criteria"])
        descs = [f"{k}: {v or k}" for k, v in q["criteria"].items()]
    else:
        keys = list(q["criteria"])
        descs = [f"{i}: {d}" for i, d in enumerate(keys)]
    if len(keys) > len(JEVK5_LETTERS):
        raise OptionLimit(
            f"engine 'logprob' (template jevk5) cannot serve {len(keys)} options (limit "
            f"{len(JEVK5_LETTERS)}). Pass --max-options {len(JEVK5_LETTERS)} or use --engine kev."
        )
    labels = list(JEVK5_LETTERS[: len(keys)])
    payload = {"evidence": state, "criterion": q["instructions"],
               "options": [{"letter": l, "description": d} for l, d in zip(labels, descs)]}
    return JEVK5_SYSTEM, json.dumps(payload, ensure_ascii=False), labels, keys


STOP = set("the and for with this that from into what which should agent user just said your you are can "
           "not all any use run".split())


def words(text):
    # ponytail: 5-char prefix as a stemmer ("conflicts" ~ "conflict"); swap in BM25 or a
    # reranker if pre-filter recall on the replay set is too low.
    return {w[:5] for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOP}


def prefilter(state, q, k):
    """Lexical top-k of a choice question's options: IDF-weighted word overlap between
    state+instructions and "key description". `none` is always kept. -> (q', dropped keys)."""
    crit = q.get("criteria")
    if q["type"] != "choice" or not k or not isinstance(crit, dict) or len(crit) <= k:
        return q, []
    state_text = state if isinstance(state, str) else json.dumps(state)
    query = words(state_text + " " + q["instructions"])
    docs = {key: words(key.replace("_", " ").replace("-", " ") + " " + (d or "")) for key, d in crit.items()}
    df = {}
    for ws in docs.values():
        for w in ws:
            df[w] = df.get(w, 0) + 1
    score = {key: sum(math.log(1 + len(docs) / df[w]) for w in ws & query) for key, ws in docs.items()}
    order = sorted(crit, key=lambda key: (key != "none", -score[key]))  # stable: ties keep catalog order
    keep = set(order[:k])
    return dict(q, criteria={key: d for key, d in crit.items() if key in keep}), [x for x in crit if x not in keep]


def pack(q, keys, probs):
    """probs: list aligned with keys -> the Answer shape for this question type."""
    if q["type"] == "noul":
        return {"probability": probs[0]}
    table = {k: p for k, p in zip(keys, probs)}
    best = max(table, key=table.get)
    if q["type"] == "score":
        return {"level": best, "probabilities": table}
    return {"choice": best, "probabilities": table, "confidence": confidence(table)}


class LogprobEngine:
    kind = "logprob"

    def __init__(self, model_id, temp=1.0, calibrate=True, template="plain", max_options=0):
        from mlx_lm import load

        self.model_id, self.temp, self.calibrate = model_id, temp, calibrate
        self.template, self.max_options = template, max_options
        self.model, self.tok = load(model_id)
        self._label_ids = {}
        self._prior = {}
        self.ask("warmup", {"w": {"type": "noul", "instructions": "ok?"}})  # compile kernels

    def label_tokens(self, label):
        """Token ids for the label written bare and space-prefixed, whichever are
        single tokens. Which one the model emits depends on how the chat template
        ends, so we score both and sum."""
        if label not in self._label_ids:
            ids = []
            for form in (label, " " + label):
                e = self.tok.encode(form, add_special_tokens=False)
                if len(e) == 1:
                    ids.append(e[0])
            if not ids:
                raise ValueError(f"label {label!r} is not a single token")
            self._label_ids[label] = ids
        return self._label_ids[label]

    def prompt_ids(self, system, user):
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        try:
            text = self.tok.apply_chat_template(
                msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False
            )
        except TypeError:  # template without a thinking switch
            text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        if self.template == "jevk5":  # JevK5 reads the letter right after the template
            return self.tok.encode(text, add_special_tokens=False)
        return self.tok.encode(text + "\n\nAnswer:")

    def _scores(self, labels, ids, cache=None):
        """Next-token logprob of each label after one forward pass."""
        import copy as _copy
        import mlx.core as mx
        import mlx.nn as nn

        out = self.model(mx.array(ids)[None], cache=_copy.deepcopy(cache) if cache else None)
        lp = nn.log_softmax(out[0, -1].astype(mx.float32)).tolist()
        return [max(lp[i] for i in self.label_tokens(l)) for l in labels]

    def prior(self, state, q, labels):
        """Contextual calibration (Zhao et al. 2021): the label distribution this
        prompt template produces on a content-free state. Subtracting it in log
        space removes the model's standing preference for "yes" or for option A.
        Cached per template, so a repeated question costs nothing extra."""
        key = (q["type"], q["instructions"], tuple(labels))
        if key not in self._prior:
            blank = dict(q)
            s, u, _, _ = render("N/A", blank, self.template)
            self._prior[key] = self._scores(labels, self.prompt_ids(s, u))
        return self._prior[key]

    def ask(self, state, questions):
        import mlx.core as mx
        from mlx_lm.models.cache import make_prompt_cache

        filtered = {qid: prefilter(state, q, self.max_options) for qid, q in questions.items()}
        rendered = [render(state, q, self.template) for q, _ in filtered.values()]
        toks = [self.prompt_ids(s, u) for s, u, _, _ in rendered]

        # The system block holding `state` is identical across questions, so
        # prefill the common token prefix once and fork the KV cache per question.
        shared = 0
        for col in zip(*toks):
            if len(set(col)) != 1 or shared >= min(map(len, toks)) - 1:
                break
            shared += 1

        cache = make_prompt_cache(self.model)
        if shared:
            mx.eval(self.model(mx.array(toks[0][:shared])[None], cache=cache))

        answers = {}
        for (qid, (q, dropped)), (_, _, labels, keys), t in zip(filtered.items(), rendered, toks):
            scores = self._scores(labels, t[shared:], cache)
            if self.calibrate:
                scores = [s - p for s, p in zip(scores, self.prior(state, q, labels))]
            scores = [s / self.temp for s in scores]
            m = max(scores)
            exp = [math.exp(s - m) for s in scores]
            total = sum(exp)
            # Options the pre-filter dropped are reported, at probability 0, not hidden.
            answers[qid] = pack(q, keys + dropped, [e / total for e in exp] + [0.0] * len(dropped))
        return answers, sum(len(t) for t in toks) - shared * (len(toks) - 1)


class RerankerEngine:
    """Cross-encoder relevance as a choice/noul backend. One (state+instructions,
    option) pair per option; softmax the relevance logits for choice, sigmoid for noul."""

    kind = "reranker"

    def __init__(self, model_id, temp=1.0):
        from sentence_transformers import CrossEncoder

        self.model_id, self.temp = model_id, temp
        self.model = CrossEncoder(model_id, device="mps")
        self.ask("warmup", {"w": {"type": "noul", "instructions": "ok?"}})

    def ask(self, state, questions):
        state_text = state if isinstance(state, str) else json.dumps(state)
        pairs, spans, meta = [], [], []
        for qid, q in questions.items():
            if q["type"] == "noul":
                keys, descs = ["yes", "no"], [q["instructions"]]
            elif q["type"] == "choice":
                keys = list(q["criteria"])
                descs = [f"{k}: {v}" for k, v in q["criteria"].items()]
            else:
                keys = descs = list(q["criteria"])
            query = f"{state_text}\n\n{q['instructions']}"
            spans.append((len(pairs), len(pairs) + len(descs)))
            pairs += [[query, d] for d in descs]
            meta.append((qid, q, keys))

        raw = self.model.predict(pairs, activation_fn=None).tolist() if pairs else []
        answers = {}
        for (qid, q, keys), (a, b) in zip(meta, spans):
            s = [float(x) / self.temp for x in raw[a:b]]
            if q["type"] == "noul":
                p = 1 / (1 + math.exp(-s[0]))
                probs = [p, 1 - p]
            else:
                m = max(s)
                exp = [math.exp(x - m) for x in s]
                probs = [e / sum(exp) for e in exp]
            answers[qid] = pack(q, keys, probs)
        return answers, sum(len(p[0]) + len(p[1]) for p in pairs) // 4


class KevEngine:
    """Proxy to a running `kev.serve` (github.com/jaredpalmer/kev). Kev already
    speaks POST /v1/systemone, but its noul and score answers are shaped
    `{noul: p}` and `{score: float, legend: {...}}`; the extension's contract
    wants `{probability}` and `{level, probabilities}`. This translates."""

    kind = "kev"

    def __init__(self, base_url, temp=1.0, template="plain", max_options=0):
        self.base_url = base_url.rstrip("/")
        self.model_id = base_url
        self.template, self.max_options = template, max_options
        import urllib.request

        try:
            with urllib.request.urlopen(self.base_url + "/v1/models", timeout=30) as r:
                m = (json.load(r).get("models") or [{}])[0]
                self.model_id = f"{base_url} {m.get('run', '?')} ({m.get('backend')}/{m.get('dtype')}, T={m.get('temperature')})"
        except Exception as e:  # jevk5-serve has only /health
            try:
                with urllib.request.urlopen(self.base_url + "/health", timeout=30) as r:
                    self.model_id = f"{base_url} {json.load(r).get('model', '?')}"
            except Exception:
                print(f"warning: {base_url} answers neither /v1/models nor /health ({e})", file=sys.stderr)

    def ask(self, state, questions):
        import urllib.request

        # Pre-filter and refuse here, before forwarding: jevk5-serve has no option-count check.
        filtered = {qid: prefilter(state, q, self.max_options) for qid, q in questions.items()}
        if self.template == "jevk5":
            for q, _ in filtered.values():
                render_jevk5(state, q)  # raises OptionLimit over 16
        sent = {qid: q for qid, (q, _) in filtered.items()}
        body = json.dumps({"model": "kev-latest", "state": state, "questions": sent}).encode()
        req = urllib.request.Request(
            self.base_url + "/v1/systemone", body, {"content-type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.load(r)
        answers = {}
        for qid, a in out["answers"].items():
            if a.get("type") == "noul" or "noul" in a:
                answers[qid] = {"probability": a["noul"]}
            elif a.get("type") == "score" or "legend" in a:
                # jevk5-serve keys levels "0", "1", ... with no legend.
                legend = a.get("legend") or {str(i): lvl for i, lvl in enumerate(sent[qid]["criteria"])}
                probs = {legend.get(k, k): v for k, v in a["probabilities"].items()}
                answers[qid] = {"level": max(probs, key=probs.get), "probabilities": probs}
            else:
                answers[qid] = {
                    "choice": a["choice"],
                    "probabilities": {**a["probabilities"], **dict.fromkeys(filtered[qid][1], 0.0)},
                    "confidence": a.get("confidence", confidence(a["probabilities"])),
                }
        return answers, out.get("usage", {}).get("input_tokens", 0)


def handler_for(engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") == "/healthz":
                self._send(200, {"status": "ok", "engine": engine.kind, "model": engine.model_id})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/systemone":
                return self._send(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                questions = req["questions"]
                if not isinstance(questions, dict) or not questions:
                    raise ValueError("questions must be a non-empty object")
                for qid, q in questions.items():
                    if q.get("type") not in ("choice", "noul", "score"):
                        raise ValueError(f"question {qid}: bad type {q.get('type')!r}")
                    if q["type"] != "noul" and not q.get("criteria"):
                        raise ValueError(f"question {qid}: {q['type']} needs criteria")
            except Exception as e:
                return self._send(400, {"error": str(e)})
            try:
                t0 = time.perf_counter()
                answers, ntok = engine.ask(req.get("state", ""), questions)
                self._send(
                    200,
                    {
                        "answers": answers,
                        "usage": {"input_tokens": ntok},
                        "latencyMs": round((time.perf_counter() - t0) * 1000, 1),
                        "backend": f"local:{engine.kind}",
                    },
                )
            except OptionLimit as e:
                # The request is unservable by this engine, not a server fault: say so plainly.
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


ENGINES = {"logprob": LogprobEngine, "reranker": RerankerEngine, "kev": KevEngine}
DEFAULT_MODEL = {
    "logprob": "mlx-community/Qwen3-1.7B-4bit",
    "reranker": "BAAI/bge-reranker-v2-m3",
    "kev": "http://127.0.0.1:8009",
}


def engine_kw(a):
    kw = {"template": a.template, "max_options": a.max_options}
    if a.engine == "logprob":
        kw["calibrate"] = not a.no_calibrate
    return kw if a.engine != "reranker" else {}


def build(engine="kev", model=None, temp=1.0, **kw):
    return ENGINES[engine](model or DEFAULT_MODEL[engine], temp, **kw)


def demo():
    """Self-check: the engine must get an obvious choice, noul and score right."""
    # An option set the label alphabet cannot address is refused, never truncated.
    big = {"type": "choice", "instructions": "?", "criteria": {f"o{i}": str(i) for i in range(len(LABELS) + 1)}}
    try:
        render("s", big)
        raise AssertionError("render accepted more options than it has labels")
    except OptionLimit as e:
        assert "kev" in str(e), e
    assert len(render("s", {"type": "choice", "instructions": "?",
                            "criteria": {f"o{i}": str(i) for i in range(len(LABELS))}})[2]) == len(LABELS)
    j = json.loads(render("st", {"type": "noul", "instructions": "ok?"}, template="jevk5")[1])
    assert j["evidence"] == "st" and j["options"][0]["description"].startswith("true:"), j
    try:
        render("s", {"type": "choice", "instructions": "?", "criteria": {str(i): "" for i in range(17)}},
               template="jevk5")
        raise AssertionError("jevk5 template accepted 17 options")
    except OptionLimit:
        pass
    # Pre-filter keeps `none` and the lexical match, drops the rest, never exceeds k.
    cat = {"type": "choice", "instructions": "Which tool?", "criteria": {
        "read": "Read a file from disk", "web_search": "Search the public web", "schedule_prompt":
        "Schedule a prompt for later", "memory_save": "Save a note to memory", "none": "No tool"}}
    kept, dropped = prefilter("please search the web for mlx", cat, 2)
    assert list(kept["criteria"]) == ["web_search", "none"] and len(dropped) == 3, (kept, dropped)
    assert prefilter("x", cat, 0) == (cat, [])
    noul = {"type": "noul", "instructions": "ok?"}  # nouls carry no criteria
    assert prefilter("x", noul, 2) == (noul, [])

    e = build(os.environ.get("ENGINE", "kev"), os.environ.get("MODEL") or None)
    state = "The user typed: 'print the contents of the file /etc/hosts on this machine'."
    ans, ntok = e.ask(
        state,
        {
            "tool": {
                "type": "choice",
                "instructions": "Which tool should run first?",
                "criteria": {
                    "read": "read a file from the local disk",
                    "web_search": "search the public internet",
                    "schedule_prompt": "schedule a prompt to run later",
                },
            },
            "needed": {"type": "noul", "instructions": "Does this task involve a local file?"},
            "sev": {"type": "score", "instructions": "How urgent?", "criteria": ["low", "high"]},
        },
    )
    print(json.dumps(ans, indent=1), ntok)
    assert ans["tool"]["choice"] == "read", ans["tool"]
    assert abs(sum(ans["tool"]["probabilities"].values()) - 1) < 1e-6
    assert 0 <= ans["tool"]["confidence"] <= 1
    assert ans["needed"]["probability"] > 0.5, ans["needed"]
    assert set(ans["sev"]["probabilities"]) == {"low", "high"}
    print("ok")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--engine", default="kev", choices=list(ENGINES))
    p.add_argument("--model", default=None)
    p.add_argument("--temp", type=float, default=1.0, help="temperature on the label logits")
    p.add_argument("--no-calibrate", action="store_true",
                   help="logprob engine: skip contextual calibration (raw logits)")
    p.add_argument("--template", default="plain", choices=["plain", "jevk5"],
                   help="logprob: prompt template (jevk5 = JevK5's SemIf JSON prompt, A-P); "
                        "kev: jevk5 refuses >16 options before forwarding")
    p.add_argument("--max-options", type=int, default=0,
                   help="logprob/kev: lexical pre-filter of choice options to this many (0 = off)")
    p.add_argument("--port", type=int, default=47411)
    p.add_argument("--demo", action="store_true", help="run the self-check and exit")
    a = p.parse_args()
    if a.demo:
        os.environ["ENGINE"] = a.engine
        demo()
        sys.exit(0)
    t0 = time.perf_counter()
    kw = engine_kw(a)
    eng = build(a.engine, a.model, a.temp, **kw)
    print(f"{eng.kind} {eng.model_id} ready in {time.perf_counter()-t0:.1f}s", file=sys.stderr)
    print(f"listening on http://127.0.0.1:{a.port}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", a.port), handler_for(eng)).serve_forever()
