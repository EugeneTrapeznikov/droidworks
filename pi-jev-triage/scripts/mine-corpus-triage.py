#!/usr/bin/env python3
"""Third pass: tool-result chars by tool, size distribution, and how much the triage rule
(extension/src/triage/core.ts) would see: allowlist + >= 2,000 chars, blocks per result, state-cap overflow.
Prints one JSON object. Same session set as mine-sessions.py (top-level *.jsonl > 50 KB)."""
import json, os, re, glob, collections

ROOT = os.path.expanduser("~/.pi/agent/sessions")
files = sorted(f for f in glob.glob(f"{ROOT}/*/*.jsonl") if os.path.getsize(f) > 50_000)
ALLOW = ["read", "bash", "grep", "find", "ls", "fetch_url", "mcp"]
DENY = {"edit", "write", "pi_jev_recall"}
MIN_CHARS, BLOCK_LINES, BLOCK_CHARS, CAPS = 2000, 25, 1500, (24_000, 80_000)


def matches(name):  # core.ts matchesTool
    return name not in DENY and any(name == a or name.startswith(a + "_") for a in ALLOW)


def split_blocks(text):  # core.ts splitBlocks, lengths only
    lines, out, i = text.split("\n"), [], 0
    while i < len(lines):
        if len(lines[i]) > BLOCK_CHARS:
            n = len(lines[i])
            out += [min(BLOCK_CHARS, n - f) for f in range(0, n, BLOCK_CHARS)]
            i += 1
            continue
        j, chars = i, 0
        while j < len(lines) and j - i < BLOCK_LINES and (j == i or chars + len(lines[j]) + 1 <= BLOCK_CHARS):
            chars += len(lines[j]) + 1
            j += 1
        out.append(len("\n".join(lines[i:j])))
        i = j
    return out


def judged(blocks, task_len, tool, cap):  # core.ts buildState: leading run that fits
    budget = cap - min(task_len, min(2000, cap // 4)) - min(len(tool), 100)
    n = 0
    for b in blocks:
        if b > budget:
            break
        budget -= b
        n += 1
    return n


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(c["text"] for c in content if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)).strip()


def last_sentence(t):
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", t.strip()) if p.strip()]
    return parts[-1] if parts else ""


def group(name):
    return "mcp" if name.startswith("mcp") else name if name in ("read", "bash", "fetch_url", "edit", "write") else \
        "grep/find/ls" if name in ("grep", "find", "ls") else "other"


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))] if xs else 0


role_chars = collections.Counter()
by = collections.defaultdict(lambda: collections.Counter())  # group -> count, chars, elig_count, elig_chars
sizes, elig = [], []  # elig: (blocks, overflow24, overflow80, chars, unjudged24, unjudged80)
raw_names = collections.Counter()
for f in files:
    user = assistant = ""
    for line in open(f, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "message":
            continue
        m = e["message"]; r = m.get("role"); content = m.get("content", [])
        parts = [{"type": "text", "text": content}] if isinstance(content, str) else content
        n = sum(len(c.get("text", "")) for c in parts if isinstance(c, dict))
        role_chars[r] += n
        if r == "user":
            user = text_of(content)
        elif r == "assistant":
            assistant = text_of(content) or assistant
        if r != "toolResult":
            continue
        name = m.get("toolName") or "?"
        raw_names[name] += 1
        g = by[group(name)]
        g["count"] += 1; g["chars"] += n
        if matches(name) and n >= MIN_CHARS:
            g["naive_chars"] += n
        sizes.append(n)
        # core.ts makeHandler: not isError, allowlisted, largest text part >= minChars, >= 3 blocks
        texts = [c["text"] for c in parts if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)]
        if m.get("isError") or not matches(name) or not texts:
            continue
        big = max(texts, key=len)
        if len(big) < MIN_CHARS:
            continue
        blocks = split_blocks(big)
        if len(blocks) < 3:
            continue
        task_len = len("\n".join(x for x in (user and f"Task: {user}", assistant and f"Latest agent note: {last_sentence(assistant)}") if x))
        j = [judged(blocks, task_len, name, c) for c in CAPS]
        g["elig_count"] += 1; g["elig_chars"] += len(big)
        elig.append((len(blocks), j[0] < len(blocks), j[1] < len(blocks), len(big),
                     sum(blocks[j[0]:]), sum(blocks[j[1]:])))

tot_c, tot_n = sum(v["chars"] for v in by.values()), sum(v["count"] for v in by.values())
big_n = sum(1 for s in sizes if s >= MIN_CHARS); big_c = sum(s for s in sizes if s >= MIN_CHARS)
naive_c = sum(v["naive_chars"] for v in by.values())  # allowlist + >= 2,000 on total result chars, no other gates
el_c = sum(e[3] for e in elig)
bl = [e[0] for e in elig]
print(json.dumps({
    "sessions": len(files), "tool_results": tot_n, "tool_result_chars": tot_c,
    "tool_result_share_of_transcript_chars": tot_c / sum(role_chars.values()),
    "by_tool": {k: {"results": v["count"], "chars": v["chars"], "share_results": v["count"] / tot_n,
                    "share_chars": v["chars"] / tot_c, "eligible_results": v["elig_count"],
                    "eligible_chars": v["elig_chars"]} for k, v in sorted(by.items(), key=lambda kv: -kv[1]["chars"])},
    "size_p50": pct(sizes, 50), "size_p90": pct(sizes, 90), "size_p99": pct(sizes, 99),
    "share_results_ge_2000": big_n / tot_n, "share_chars_ge_2000": big_c / tot_c,
    "eligible_results": len(elig), "eligible_share_of_results": len(elig) / tot_n,
    "eligible_share_of_chars": el_c / tot_c, "allowlist_ge_2000_share_of_chars": naive_c / tot_c,
    "blocks_p50": pct(bl, 50), "blocks_p95": pct(bl, 95),
    "eligible_over_24k": sum(e[1] for e in elig) / len(elig), "eligible_over_80k": sum(e[2] for e in elig) / len(elig),
    "unjudged_chars_share_24k": sum(e[4] for e in elig) / el_c, "unjudged_chars_share_80k": sum(e[5] for e in elig) / el_c,
    "size_hist": {lab: [sum(1 for s in sizes if lo <= s < hi), sum(s for s in sizes if lo <= s < hi)] for lab, lo, hi in
                  [("<500", 0, 500), ("500-2k", 500, 2000), ("2k-8k", 2000, 8000), ("8k-24k", 8000, 24000),
                   ("24k-80k", 24000, 80000), (">=80k", 80000, 1 << 62)]},
    "top_raw_tool_names": raw_names.most_common(25),
}, indent=1))
