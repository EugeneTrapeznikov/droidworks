#!/usr/bin/env python3
"""Second pass: latency per model call, context size distribution, tool-result sizes by tool, static-prefix cost share."""
import json, os, glob, collections, statistics
from datetime import datetime

ROOT = os.path.expanduser("~/.pi/agent/sessions")
files = [f for f in glob.glob(f"{ROOT}/*/*.jsonl") if os.path.getsize(f) > 50_000]
PREFIX = 16_250
IN_RATE, CR_RATE, OUT_RATE = 5.0, 0.5, 15.0  # $/M observed for gpt-5.6-sol (output approx)

lat = []            # seconds between previous message and assistant message
ctx_sizes = []
tr_chars = collections.Counter(); tr_count = collections.Counter(); tr_big = collections.Counter()
prefix_tokens_cached = prefix_tokens_uncached = 0
cost_in = cost_cr = cost_out = 0.0
compactions = 0
first_turn_inputs = []
by_provider = collections.Counter()

def ts(e):
    t = e.get("timestamp") or e.get("message", {}).get("timestamp")
    if t is None: return None
    if isinstance(t, (int, float)): return t / 1000 if t > 1e11 else t
    try: return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp()
    except Exception: return None

for f in files:
    prev_t = None; first = True
    for line in open(f, errors="ignore"):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "compaction": compactions += 1
        if e.get("type") != "message": continue
        m = e["message"]; r = m.get("role"); t = ts(e)
        if r == "toolResult":
            name = m.get("toolName") or "?"
            content = m.get("content", [])
            n = sum(len(c.get("text", "")) for c in content if isinstance(c, dict))
            tr_chars[name] += n; tr_count[name] += 1
            if n > 20_000: tr_big[name] += 1
        if r == "assistant":
            u = m.get("usage") or {}
            inp, cr, out = u.get("input", 0), u.get("cacheRead", 0), u.get("output", 0)
            if not inp and not cr:
                prev_t = t; continue
            by_provider[(m.get("provider"), m.get("model"))] += 1
            ctx = inp + cr; ctx_sizes.append(ctx)
            if first: first_turn_inputs.append(inp); first = False
            if t and prev_t and 0 < t - prev_t < 600: lat.append(t - prev_t)
            # static prefix: assume it is cached whenever cacheRead>0 (prefix is the first thing cached)
            if cr > 0: prefix_tokens_cached += min(PREFIX, cr)
            else: prefix_tokens_uncached += min(PREFIX, inp)
            c = u.get("cost") or {}
            cost_in += c.get("input", 0) or 0; cost_cr += c.get("cacheRead", 0) or 0; cost_out += c.get("output", 0) or 0
        prev_t = t

def pct(v, p):
    v = sorted(v); return v[int(len(v) * p)] if v else 0
print(f"model calls={len(ctx_sizes):,}  compactions={compactions:,}")
print(f"context/call tokens: p50={pct(ctx_sizes,.5):,} p90={pct(ctx_sizes,.9):,} mean={statistics.mean(ctx_sizes):,.0f}")
print(f"first-turn input: p50={pct(first_turn_inputs,.5):,} mean={statistics.mean(first_turn_inputs):,.0f} n={len(first_turn_inputs)}")
if lat: print(f"latency/call s (prev msg -> assistant msg): p50={pct(lat,.5):.1f} p90={pct(lat,.9):.1f} mean={statistics.mean(lat):.1f} n={len(lat):,}")
total_cost = cost_in + cost_cr + cost_out
print(f"cost split: input ${cost_in:,.0f} ({100*cost_in/total_cost:.0f}%)  cacheRead ${cost_cr:,.0f} ({100*cost_cr/total_cost:.0f}%)  output ${cost_out:,.0f} ({100*cost_out/total_cost:.0f}%)")
pc = prefix_tokens_cached * CR_RATE / 1e6 + prefix_tokens_uncached * IN_RATE / 1e6
print(f"static 16k prefix: cached tokens {prefix_tokens_cached:,} uncached {prefix_tokens_uncached:,} -> ~${pc:,.0f} ({100*pc/total_cost:.1f}% of cost)")
tot_tr = sum(tr_chars.values())
print("\ntool result chars by tool (share, count, >20k results):")
for name, n in tr_chars.most_common(12):
    print(f"  {name:16s} {100*n/tot_tr:5.1f}%  n={tr_count[name]:6,}  mean={n//max(1,tr_count[name]):7,} chars  big={tr_big[name]:,}")
print("\nproviders:", by_provider.most_common(6))
