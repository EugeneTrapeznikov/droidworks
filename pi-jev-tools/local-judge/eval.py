#!/usr/bin/env python3
"""Build a 60-item local set and score an engine on it.

    uv run --python .venv python eval.py --engine logprob --model mlx-community/Qwen3-1.7B-4bit

30 routing choices over the user's real Pi catalog (18 active tools,
33 skills from ~/.pi/agent/settings.json),
10 "none needed" prompts against the same catalogs, and 20 block-relevance
nouls built from code files in this repo. Writes eval.jsonl next to this file.
"""

import argparse, glob, json, os, re, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")

TOOLS = {
    "read": "Read a file from the local filesystem",
    "bash": "Execute a shell command",
    "edit": "Replace an exact string in an existing file",
    "write": "Create or overwrite a file with new contents",
    "subagent": "Launch background sub-agents to work on tasks in parallel",
    "bg_wait": "Wait for an already-running background sub-agent to finish",
    "subagent_supervisor": "Inspect and manage running sub-agents",
    "mcp": "Gateway to MCP servers: search, describe and call their tools",
    "mcpScript": "Run a scripted sequence of MCP tool calls",
    "mcp__browsermcp": "Drive a real browser: navigate, click, type, screenshot",
    "web_research": "Deep multi-source web research with citations",
    "web_search": "Search the public web and return result snippets",
    "fetch_url": "Fetch the contents of a URL",
    "schedule_prompt": "Schedule a prompt to run later at a given time",
    "memory_search": "Search long-term agent memory for past observations",
    "memory_save": "Save a note or learning to long-term agent memory",
    "memory_health": "Report the health of the agent memory store",
    "create_goal": "Create a tracked goal for the current project",
    "none": "No tool is needed; answer directly",
}

TOOL_CASES = [
    ("show me the contents of extension/src/judge/types.ts", "read"),
    ("what's the git status on this branch right now?", "bash"),
    ("rename the variable `foo` to `bar` in utils.py", "edit"),
    ("create a new file called LICENSE containing the MIT text", "write"),
    ("research every open-weight reranker released this year and write it up with sources", "web_research"),
    ("what is the latest version of the mlx-lm package on PyPI?", "web_search"),
    ("pull down https://raw.githubusercontent.com/ml-explore/mlx-lm/main/README.md", "fetch_url"),
    ("remind me to review the open PR tomorrow morning at 9", "schedule_prompt"),
    ("did we ever work out why the prompt cache kept missing?", "memory_search"),
    ("remember that the deploy box is called atlas", "memory_save"),
    ("open the staging site in a browser and click through the checkout flow", "mcp__browsermcp"),
    ("spawn three workers to port each package in parallel", "subagent"),
    ("is that background port job finished yet?", "bg_wait"),
    ("list the tools the Jira MCP server exposes", "mcp"),
    ("set a goal to ship the local judge by Friday", "create_goal"),
]

TOOL_NONE = [
    "what does ECE stand for?",
    "thanks, that looks right",
    "explain the difference between a cross-encoder and a bi-encoder",
    "which is bigger, 1.7B or 4B?",
    "summarise what you just told me in one sentence",
]

# gold may be a set: several of the user's skills are near-duplicates
# (grilling / grill-me / grill-with-docs, handoff / handoff-doc).
SKILL_CASES = [
    ("this rebase has conflicts in three files, help me get through it", ["resolving-merge-conflicts"]),
    ("write the tests first and then the feature", ["tdd"]),
    ("the server 500s only under load, figure out why", ["diagnosing-bugs"]),
    ("turn this plan into tickets in the tracker", ["to-tickets"]),
    ("download the transcript of this youtube video", ["youtube-transcript"]),
    ("make an HTML report of these findings that I can share with the team", ["visual-report"]),
    ("copy the design system off stripe.com so our agents can use it", ["website-design-capture"]),
    ("review the diff on this branch", ["code-review"]),
    ("I want to pin down the vocabulary for our billing domain", ["domain-modeling"]),
    ("walk me through provisioning the CI secrets, I have to click through the dashboard myself", ["wizard"]),
    ("I'm nearly out of context, write something so the next agent can pick this up", ["handoff", "handoff-doc"]),
    ("poke holes in this architecture proposal until it breaks", ["grilling", "grill-me", "grill-with-docs"]),
    ("look up what the current best practice is and give me the sources", ["research"]),
    ("plan six months of work as a map of decisions no single session can hold", ["wayfinder"]),
    ("teach me how the MLX prompt cache actually works", ["teach"]),
]

SKILL_NONE = ["yes", "what time is it in Tokyo?", "hi", "what's 17 * 23?", "ok do that"]

BLOCK_Q = ("Will the agent have to read or edit this exact code block to complete the task? "
           "Answer no if it is from an unrelated file or an unrelated part of the code.")
BLOCK_FILES = ["mine-sessions.py", "mine-sessions-cost.py", "probe-window.ts"]
# (task, {block_key: gold_yes}) — hand-labelled against the 25-line chunks below.
BLOCK_TASKS = [
    (
        "Add a `docker` class to the bash command classifier in the session miner, "
        "so docker commands stop being counted as 'other'.",
        {"mine-sessions.py#1": 1, "mine-sessions.py#2": 1, "mine-sessions.py#3": 1,
         "mine-sessions.py#4": 0, "mine-sessions.py#5": 1},
    ),
    (
        "The probe writes each skill's description length but not its token cost. "
        "Make it record approximate tokens per skill description.",
        {"probe-window.ts#1": 1, "probe-window.ts#2": 1},
    ),
]


def skills():
    s = json.load(open(os.path.expanduser("~/.pi/agent/settings.json")))["skills"]
    paths = []
    for p in s:
        paths += [p] if p.endswith("SKILL.md") else glob.glob(os.path.join(p, "**", "SKILL.md"), recursive=True)
    out = {}
    for p in sorted(set(paths)):
        m = re.match(r"---\n(.*?)\n---", open(p).read(8000), re.S)
        if not m:
            continue
        fm = m.group(1)
        n = re.search(r"^name:\s*(.+)$", fm, re.M)
        d = re.search(r"^description:\s*>?-?\s*(.+(?:\n[ \t]+.+)*)$", fm, re.M)
        if n:
            out[n.group(1).strip()] = " ".join((d.group(1) if d else "").split())[:255]
    out["none"] = "No skill is needed; answer directly"
    return out


def blocks():
    """25-line chunks of real files in this repo, keyed file#n."""
    out = {}
    for f in BLOCK_FILES:
        lines = open(os.path.join(SCRIPTS, f)).read().splitlines()
        for i in range(0, len(lines), 25):
            out[f"{f}#{i//25+1}"] = f"{f} lines {i+1}-{min(i+25,len(lines))}:\n" + "\n".join(lines[i : i + 25])
    return out


def build():
    sk, bl = skills(), blocks()
    items = []
    for prompt, gold in TOOL_CASES + [(p, "none") for p in TOOL_NONE]:
        items.append({
            "id": f"tool/{len(items)}", "group": "tool" if gold != "none" else "none",
            "state": f"The user just said:\n{prompt}",
            "q": {"type": "choice", "instructions":
                  "Which single tool should the agent reach for first to serve this request?",
                  "criteria": TOOLS},
            "gold": [gold]})
    for prompt, gold in SKILL_CASES + [(p, ["none"]) for p in SKILL_NONE]:
        items.append({
            "id": f"skill/{len(items)}", "group": "skill" if gold != ["none"] else "none",
            "state": f"The user just said:\n{prompt}",
            "q": {"type": "choice", "instructions":
                  "Which single skill should the agent load to serve this request?",
                  "criteria": sk},
            "gold": gold})
    for task, labels in BLOCK_TASKS:
        for key, text in bl.items():
            items.append({
                "id": f"block/{len(items)}", "group": "block",
                "state": f"CURRENT TASK: {task}\n\nCODE BLOCK:\n{text}",
                # The negative clause matters more than the model: on kev-0.8b the
                # bare "is this block needed?" scores 0.30 (it says yes to
                # everything) and this phrasing scores 0.75. See RESULTS.md.
                "q": {"type": "noul", "instructions": BLOCK_Q},
                "gold": labels.get(key, 0)})
    return items


def ece(pairs, bins=10):
    """pairs: (confidence in the predicted label, 1 if that label was right)."""
    if not pairs:
        return 0.0
    tot = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [p for p in pairs if (lo < p[0] <= hi) or (b == 0 and p[0] <= 0)]
        if sel:
            tot += len(sel) / len(pairs) * abs(
                sum(c for c, _ in sel) / len(sel) - sum(k for _, k in sel) / len(sel))
    return tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="logprob")
    ap.add_argument("--model", default=None)
    ap.add_argument("--temp", type=float, default=1.0)
    ap.add_argument("--no-calibrate", action="store_true")
    ap.add_argument("--template", default="plain")
    ap.add_argument("--max-options", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(HERE, "results.jsonl"))
    a = ap.parse_args()

    import resource
    import server

    items = build()
    with open(os.path.join(HERE, "eval.jsonl"), "w") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")

    t0 = time.perf_counter()
    kw = server.engine_kw(a)
    eng = server.build(a.engine, a.model, a.temp, **kw)
    cold_load = time.perf_counter() - t0

    # cold = first real request after load; warm = everything after.
    lat, rows = [], []
    for it in items:
        t = time.perf_counter()
        ans, ntok = eng.ask(it["state"], {"q": it["q"]})
        lat.append((time.perf_counter() - t) * 1000)
        ans = ans["q"]
        if it["q"]["type"] == "noul":
            p = ans["probability"]
            pred, conf, ok = int(p > 0.5), max(p, 1 - p), int(p > 0.5) == it["gold"]
        else:
            pred = ans["choice"]
            conf, ok = max(ans["probabilities"].values()), pred in it["gold"]
        rows.append({"id": it["id"], "group": it["group"], "pred": pred, "gold": it["gold"],
                     "ok": bool(ok), "conf": conf, "tokens": ntok})

    # batched: all 10 blocks of one task in a single request, shared state prefill.
    task, labels = BLOCK_TASKS[0]
    bl = blocks()
    qs = {k.replace("#", "_").replace(".", "_"): {
              "type": "noul", "instructions": f"CODE BLOCK:\n{v}\n\nIs this block needed for the task?"}
          for k, v in bl.items()}
    t = time.perf_counter()
    eng.ask(f"CURRENT TASK: {task}", qs)
    batch_ms = (time.perf_counter() - t) * 1000

    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9
    summary = {
        "engine": a.engine, "model": a.model or server.DEFAULT_MODEL[a.engine], "temp": a.temp,
        "calibrated": a.engine == "logprob" and not a.no_calibrate,
        **({"template": a.template, "max_options": a.max_options}
           if a.engine == "logprob" else {}),
        "cold_load_s": round(cold_load, 1),
        "cold_req_ms": round(lat[0], 1), "p50_ms": round(statistics.median(lat[1:]), 1),
        "p95_ms": round(sorted(lat[1:])[int(0.95 * len(lat[1:]))], 1),
        "batch10_nouls_ms": round(batch_ms, 1),
        "rss_gb": round(rss, 2),
        "n": len(rows), "acc": round(sum(r["ok"] for r in rows) / len(rows), 3),
        "ece": round(ece([(r["conf"], r["ok"]) for r in rows]), 3),
        "mean_conf": round(statistics.mean(r["conf"] for r in rows), 3),
    }
    for g in ("tool", "skill", "none", "block"):
        sub = [r for r in rows if r["group"] == g]
        summary[f"acc_{g}"] = round(sum(r["ok"] for r in sub) / len(sub), 3)
        summary[f"n_{g}"] = len(sub)

    with open(a.out, "a") as f:
        f.write(json.dumps({"summary": summary, "rows": rows}) + "\n")
    print(json.dumps(summary, indent=1))
    for r in rows:
        if not r["ok"]:
            print(f"  MISS {r['id']:12s} pred={r['pred']!s:24s} gold={r['gold']} conf={r['conf']:.2f}")


if __name__ == "__main__":
    main()
