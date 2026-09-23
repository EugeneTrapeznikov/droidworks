#!/usr/bin/env python3
"""Mine Pi session JSONL files: where do model calls and tokens go, and which turns are choice-shaped."""
import json, os, re, sys, glob, collections

ROOT = os.path.expanduser("~/.pi/agent/sessions")
files = [f for f in glob.glob(f"{ROOT}/*/*.jsonl") if os.path.getsize(f) > 50_000]
SEARCH_RE = re.compile(r"\b(rg|grep|find|ls|fd|git (status|log|diff|show)|cat|head|tail|wc|tree)\b")

S = collections.Counter()      # scalar totals
T = collections.Counter()      # tokens
TOOLS = collections.Counter()  # tool call names
BASH = collections.Counter()   # bash command classes
CHAIN = collections.Counter()  # pattern: prev tool -> next turn
ROLE_CHARS = collections.Counter()
SPEC_TOK = collections.Counter()
n_sessions = 0

def bash_class(cmd: str) -> str:
    c = cmd.strip()
    if re.match(r"^(git )?(status|log|diff|show|branch)", c) or c.startswith("git "):
        return "git"
    if re.match(r"^(rg|grep|find|fd|ls|tree|wc|cat|head|tail|sed -n)\b", c):
        return "search/read"
    if re.search(r"\b(pytest|bun test|npm test|cargo test|go test|jest|vitest|make test|tsc|eslint|ruff|mypy)\b", c):
        return "test/lint"
    if re.match(r"^(cd .* && )?(python3?|node|bun|npx|uv|pip|npm|cargo|go|make)\b", c):
        return "run"
    return "other"

for f in files:
    n_sessions += 1
    prev_tool_results = []   # toolResults since last assistant msg: list of (toolName, text)
    prev_assistant_tools = []
    for line in open(f, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "message":
            continue
        m = e["message"]; r = m.get("role")
        content = m.get("content", [])
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        chars = sum(len(c.get("text", "")) for c in content if isinstance(c, dict))
        ROLE_CHARS[r] += chars
        if r == "user":
            S["user_prompts"] += 1
            prev_tool_results = []
        elif r == "toolResult":
            prev_tool_results.append((m.get("toolName"), "".join(c.get("text", "") for c in content if isinstance(c, dict))))
        elif r == "assistant":
            u = m.get("usage") or {}
            if not u.get("input") and not u.get("cacheRead"):
                continue  # aborted/empty
            S["model_calls"] += 1
            inp, cr, out = u.get("input", 0), u.get("cacheRead", 0), u.get("output", 0)
            T["input"] += inp; T["cacheRead"] += cr; T["output"] += out
            T["reasoning"] += u.get("reasoning", 0) or 0
            T["cost"] += (u.get("cost") or {}).get("total", 0) or 0
            calls = [c for c in content if c.get("type") == "toolCall"]
            texts = [c for c in content if c.get("type") == "text" and c.get("text", "").strip()]
            kind = "tool_only" if calls and not texts else "text_only" if texts and not calls else "text+tool" if calls else "empty"
            S[f"turn_{kind}"] += 1
            T[f"ctx_{kind}"] += inp + cr
            if kind == "tool_only" and len(calls) == 1:
                S["turn_tool_only_single"] += 1
                T["ctx_tool_only_single"] += inp + cr
            for c in calls:
                name = c.get("name"); TOOLS[name] += 1
                if name == "bash":
                    BASH[bash_class((c.get("arguments") or {}).get("command", ""))] += 1
            # chain: did this turn only `read` paths that appeared in the previous tool results?
            if prev_tool_results and calls and all(c.get("name") == "read" for c in calls):
                prev_text = "\n".join(t for _, t in prev_tool_results)
                paths = [(c.get("arguments") or {}).get("path", "") for c in calls]
                hits = sum(1 for p in paths if p and (p in prev_text or os.path.basename(p) in prev_text))
                prev_names = ",".join(sorted(set(n for n, _ in prev_tool_results)))
                if hits == len(paths):
                    CHAIN["read_from_prev_result"] += 1
                    SPEC_TOK["ctx"] += inp + cr; SPEC_TOK["out"] += out
                    CHAIN[f"prev={prev_names}"] += 1
                else:
                    CHAIN["read_other"] += 1
            if prev_tool_results and calls and not texts:
                CHAIN["tool_after_tool"] += 1
            prev_tool_results = []

print(f"sessions={n_sessions} user_prompts={S['user_prompts']} model_calls={S['model_calls']}  calls/prompt={S['model_calls']/max(1,S['user_prompts']):.1f}")
print(f"tokens: input={T['input']:,} cacheRead={T['cacheRead']:,} output={T['output']:,} reasoning={T['reasoning']:,} cost=${T['cost']:,.0f}")
tot = S["model_calls"]
ctx = T["input"] + T["cacheRead"]
for k in ("tool_only", "text_only", "text+tool", "empty"):
    print(f"  turn {k:10s}: {S['turn_'+k]:7,} ({100*S['turn_'+k]/tot:4.1f}% calls)  ctx tokens {T['ctx_'+k]:>13,} ({100*T['ctx_'+k]/ctx:4.1f}%)")
print(f"  tool_only with exactly 1 call: {S['turn_tool_only_single']:,} ({100*S['turn_tool_only_single']/tot:.1f}%)  ctx {T['ctx_tool_only_single']:,} ({100*T['ctx_tool_only_single']/ctx:.1f}%)")
print("\nchains:")
for k, v in CHAIN.most_common(12):
    print(f"  {k:40s} {v:7,}")
print(f"  read_from_prev_result share of calls: {100*CHAIN['read_from_prev_result']/tot:.1f}%  ctx tokens {SPEC_TOK['ctx']:,} ({100*SPEC_TOK['ctx']/ctx:.1f}%)")
print("\ntools:", TOOLS.most_common(15))
print("bash classes:", BASH.most_common())
rc = sum(ROLE_CHARS.values())
print("\ntranscript chars by role:", {k: f"{v:,} ({100*v/rc:.0f}%)" for k, v in ROLE_CHARS.most_common()})
