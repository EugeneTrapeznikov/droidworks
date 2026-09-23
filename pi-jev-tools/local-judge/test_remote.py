"""KevEngine against a fake jevk5-serve (no /v1/models, digit-keyed scores, no option check)
and a fake kev.serve (legend-keyed scores). No model is loaded.

    .venv/bin/python test_remote.py
"""
import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import server


def fake(kind, seen):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if kind == "kev" and self.path == "/v1/models":
                return self._send(200, {"models": [{"run": "kev-0.8b"}]})
            if kind == "jevk5" and self.path == "/health":
                return self._send(200, {"ok": True, "model": "alibiserikbay/JevK5"})
            self._send(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(body)
            ans = {}
            for qid, q in body["questions"].items():
                if q["type"] == "score":
                    n = len(q["criteria"])
                    probs = {(q["criteria"][i] if kind == "kev" else str(i)): 1 / n for i in range(n)}
                    probs[next(iter(probs))] += 0.1
                    ans[qid] = {"type": "score", "probabilities": probs,
                                **({"legend": {c: c for c in q["criteria"]}} if kind == "kev" else {})}
                else:
                    keys = list(q["criteria"])
                    ans[qid] = {"type": "choice", "choice": keys[0],
                                "probabilities": {k: 1 / len(keys) for k in keys}}
            self._send(200, {"answers": ans, "usage": {"input_tokens": 1}})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}"


big = {"type": "choice", "instructions": "Which tool?",
       "criteria": {**{f"t{i}": f"tool number {i}" for i in range(20)},
                    "web_search": "search the public web", "none": "no tool"}}
score = {"type": "score", "instructions": "How urgent?", "criteria": ["low", "high"]}

# jevk5-serve: probe falls back to /health; pre-filter runs before forwarding; digit levels map back.
seen = []
e = server.KevEngine(fake("jevk5", seen), template="jevk5", max_options=16)
assert "JevK5" in e.model_id, e.model_id
ans, _ = e.ask("search the web please", {"c": big, "s": score})
assert len(seen[0]["questions"]["c"]["criteria"]) == 16, "pre-filter did not run before forwarding"
assert {"web_search", "none"} <= set(seen[0]["questions"]["c"]["criteria"])
assert len(ans["c"]["probabilities"]) == 22 and list(ans["c"]["probabilities"].values()).count(0.0) == 6
assert ans["s"] == {"level": "low", "probabilities": {"low": 0.6, "high": 0.5}}, ans["s"]
# Without --max-options, jevk5 refuses >16 locally instead of forwarding.
try:
    server.KevEngine(e.base_url, template="jevk5").ask("s", {"c": big})
    raise AssertionError("forwarded 22 options to jevk5")
except server.OptionLimit:
    pass

# Real kev: unchanged — no pre-filter, legend honoured, /v1/models used.
seen = []
k = server.KevEngine(fake("kev", seen))
assert "kev-0.8b" in k.model_id
ans, _ = k.ask("s", {"c": big, "s": score})
assert len(seen[0]["questions"]["c"]["criteria"]) == 22
assert ans["s"]["level"] == "low" and set(ans["s"]["probabilities"]) == {"low", "high"}

# Unreachable server: warn, don't crash at startup.
assert server.KevEngine("http://127.0.0.1:9").model_id == "http://127.0.0.1:9"
print("ok")
