#!/usr/bin/env python3
"""Projection, not a measurement: what triage would have saved on the real Pi corpus if it hid a fixed share
of every eligible tool result's chars at ingestion. Replays each session's context: an eligible result costs
tokens on every model call whose context still holds it (compaction and branch switches drop it), priced at
that call's own recorded rates. Same session set and eligibility gates as mine-corpus-triage.py. Read-only.
Prints one JSON object."""
import json, os, glob

ROOT = os.path.expanduser("~/.pi/agent/sessions")
files = sorted(f for f in glob.glob(f"{ROOT}/*/*.jsonl") if os.path.getsize(f) > 50_000)
ALLOW, DENY = ["read", "bash", "grep", "find", "ls", "fetch_url", "mcp"], {"edit", "write", "pi_jev_recall"}
MIN_CHARS, BLOCK_LINES, BLOCK_CHARS = 2000, 25, 1500
HIDE = (0.10, 0.16, 0.25)
FALLBACK_CPT = 3.5            # chars/token when a session's own ratio is unusable
PREFIX_OVERHEAD = 155         # tokens/call: <pi-jev> system-prompt section + pi_jev_recall schema (bench/live/RESULTS.md)
STUB_TOKENS = 30              # one ~110-char stub per eligible result, re-sent like the result


def matches(n): return n not in DENY and any(n == a or n.startswith(a + "_") for a in ALLOW)


def n_blocks(text):  # core.ts splitBlocks, count only
    lines, n, i = text.split("\n"), 0, 0
    while i < len(lines):
        if len(lines[i]) > BLOCK_CHARS:
            n += -(-len(lines[i]) // BLOCK_CHARS); i += 1; continue
        j, c = i, 0
        while j < len(lines) and j - i < BLOCK_LINES and (j == i or c + len(lines[j]) + 1 <= BLOCK_CHARS):
            c += len(lines[j]) + 1; j += 1
        n += 1; i = j
    return n


def eligible_chars(m):  # core.ts makeHandler gates; returns chars of the part triage would judge
    parts = m.get("content") or []
    texts = [c["text"] for c in parts if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)]
    if m.get("isError") or not matches(m.get("toolName") or "?") or not texts:
        return 0
    big = max(texts, key=len)
    return len(big) if len(big) >= MIN_CHARS and n_blocks(big) >= 3 else 0


def visible_chars(m):  # what a message puts into the next call's context, thinking excluded
    c = m.get("content")
    if isinstance(c, str): return len(c)
    return sum(len(p.get("text", "")) if p.get("type") == "text" else len(json.dumps(p.get("arguments", "")))
               if p.get("type") == "toolCall" else 0 for p in c or [] if isinstance(p, dict))


def session(f, cpt=FALLBACK_CPT):  # cpt bounds eviction; pass 2 uses the session's own ratio
    ents = []
    for line in open(f, errors="ignore"):
        try: ents.append(json.loads(line))
        except Exception: pass
    idx = {e["id"]: i for i, e in enumerate(ents) if e.get("id")}
    par = {e["id"]: e.get("parentId") for e in ents if e.get("id")}
    elig = {}                      # tool-result id -> eligible chars
    live, prev = set(), None
    s = dict(calls=0, ctx=0.0, cost=0.0, cost_out=0.0, el_in=0.0, el_cr=0.0, el_cw=0.0, el_cost=0.0, el_cost_pos=0.0,
             el_cr_pos=0.0, sends=0, results=0, evicted=0, gap_chars=0, gap_tok=0, stub_cost=0.0, over_cost=0.0, stub_chars_calls=0)
    seen, last_ctx, gap, clean = {}, None, 0, True
    for e in ents:
        eid, t = e.get("id"), e.get("type")
        if eid and prev is not None and e.get("parentId") != prev:          # branch switch: rebuild live set from path
            path, n, cut = [], e.get("parentId"), -1
            while n in par: path.append(n); n = par[n]
            for p in path:                                                  # nearest compaction on the path wins
                if ents[idx[p]].get("type") == "compaction": cut = idx.get(ents[idx[p]].get("firstKeptEntryId"), -1); break
            live = {p for p in path if p in elig and idx[p] >= cut}; clean = False
        if eid: prev = eid
        if t == "compaction":
            cut = idx.get(e.get("firstKeptEntryId"), len(ents)); live = {r for r in live if idx[r] >= cut}; clean = False
        if t != "message": continue
        m = e["message"]; r = m.get("role")
        if r == "toolResult" and eid:
            ec = eligible_chars(m)
            if ec: elig[eid] = ec; live.add(eid); s["results"] += 1
        if r != "assistant" or not (m.get("usage") or {}):
            gap += visible_chars(m); continue
        u = m["usage"]; inp, cr, cw = u.get("input", 0) or 0, u.get("cacheRead", 0) or 0, u.get("cacheWrite", 0) or 0
        ctx = inp + cr + cw
        if not ctx: gap += visible_chars(m); continue
        c = u.get("cost") or {}
        ri, rr, rw = [(c.get(k, 0) or 0) / v if v else 0 for k, v in (("input", inp), ("cacheRead", cr), ("cacheWrite", cw))]
        ri = ri or rw or rr; rr = rr or ri                                  # rate fallbacks when a bucket is empty
        blend = (inp * ri + cr * rr + cw * rw) / ctx                          # $/token for an average context token
        s["calls"] += 1; s["ctx"] += ctx
        s["cost"] += sum(c.get(k, 0) or 0 for k in ("input", "cacheRead", "cacheWrite")); s["cost_out"] += c.get("output", 0) or 0
        s["over_cost"] += PREFIX_OVERHEAD * (rr if cr else blend)
        # Context pruned outside the transcript (extensions dropping old results, no compaction entry): evict
        # oldest live results until they fit in ctx minus the first call's context (system prompt + first prompt).
        # ponytail: oldest-first guess at what was pruned; exact only if the pruner's rule is replayed
        prefix = s.setdefault("prefix", ctx)
        room, held = (ctx - prefix) * cpt, sum(elig[x] for x in live)
        for rid in sorted(live, key=idx.get) if held > room and s["calls"] > 1 else ():
            if held <= room: break
            live.discard(rid); held -= elig[rid]; s["evicted"] += 1
        for rid in live:
            ch = elig[rid]; first = rid not in seen; seen[rid] = 1 + seen.get(rid, 0); s["sends"] += 1
            s["el_in"] += ch * inp / ctx; s["el_cr"] += ch * cr / ctx; s["el_cw"] += ch * cw / ctx; s["el_cost"] += ch * blend
            pos = (ri if first else (rr if cr else ri))                        # positional: new content uncached, old cached
            s["el_cost_pos"] += ch * pos; s["el_cr_pos"] += 0 if first else ch
            s["stub_chars_calls"] += 1; s["stub_cost"] += STUB_TOKENS * blend
        if clean and last_ctx is not None and ctx > last_ctx: s["gap_chars"] += gap; s["gap_tok"] += ctx - last_ctx
        last_ctx, gap, clean = ctx, visible_chars(m), True
    cpt = s["gap_chars"] / s["gap_tok"] if s["gap_tok"] > 5000 else 0
    s["cpt_own"] = 1.5 <= cpt <= 8
    s["cpt"] = cpt if s["cpt_own"] else FALLBACK_CPT
    s["seen"] = list(seen.values()) + [0] * (len(elig) - len(seen))
    return s


def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p / 100 * len(xs)))] if xs else 0


def summarize(ss):
    out = {"sessions": len(ss), "calls": sum(s["calls"] for s in ss), "ctx_tokens": sum(s["ctx"] for s in ss),
           "cost_total": sum(s["cost"] + s["cost_out"] for s in ss)}
    el = {k: sum(s[k] / s["cpt"] for s in ss) for k in ("el_in", "el_cr", "el_cw")}
    out["eligible_tokens"] = el; out["eligible_share_of_ctx"] = sum(el.values()) / out["ctx_tokens"]
    out["eligible_cost"] = sum(s["el_cost"] / s["cpt"] for s in ss)
    for h in HIDE:
        tok = [h * sum(s[k] for k in ("el_in", "el_cr", "el_cw")) / s["cpt"] for s in ss]
        cost = [h * s["el_cost"] / s["cpt"] for s in ss]
        over_tok = [PREFIX_OVERHEAD * s["calls"] + STUB_TOKENS * s["stub_chars_calls"] for s in ss]
        over_cost = [s["over_cost"] + s["stub_cost"] for s in ss]
        pcts = [(t - o) / s["ctx"] for t, o, s in zip(tok, over_tok, ss) if s["ctx"]]
        out[f"hide_{int(h * 100)}"] = {
            "saved_tokens": sum(tok), "saved_pct_ctx": sum(tok) / out["ctx_tokens"],
            "overhead_tokens": sum(over_tok), "net_saved_pct_ctx": (sum(tok) - sum(over_tok)) / out["ctx_tokens"],
            "saved_cost": sum(cost), "saved_cost_positional": sum(h * s["el_cost_pos"] / s["cpt"] for s in ss),
            "overhead_cost": sum(over_cost), "net_saved_pct_cost": (sum(cost) - sum(over_cost)) / out["cost_total"],
            "net_pct_p50": pct(pcts, 50), "net_pct_p90": pct(pcts, 90),
            "share_sessions_net_gt_5pct": sum(p > 0.05 for p in pcts) / len(pcts)}
    seen = [x for s in ss for x in s["seen"]]
    out["results_eligible"] = len(seen); out["results_evicted_outside_transcript"] = sum(s["evicted"] for s in ss)
    out["sends_per_result_mean"] = sum(seen) / len(seen) if seen else 0
    out["sends_per_result_p50_p90"] = [pct(seen, 50), pct(seen, 90)]
    out["cacheRead_share_positional"] = sum(s["el_cr_pos"] for s in ss) / max(1, sum(s["el_in"] + s["el_cr"] + s["el_cw"] for s in ss))
    return out


ss = [session(f, session(f)["cpt"]) for f in files]
ss = [s for s in ss if s["calls"]]
own = [s["cpt"] for s in ss if s["cpt_own"]]
print(json.dumps({"all": summarize(ss), "long_tail_gt20_calls": summarize([s for s in ss if s["calls"] > 20]),
                  "cpt_own_sessions": len(own), "cpt_fallback_sessions": len(ss) - len(own),
                  "cpt_own_p10_p50_p90": [pct(own, 10), pct(own, 50), pct(own, 90)],
                  "calls_per_session_p50_mean": [pct([s["calls"] for s in ss], 50), sum(s["calls"] for s in ss) / len(ss)]},
                 indent=1))
