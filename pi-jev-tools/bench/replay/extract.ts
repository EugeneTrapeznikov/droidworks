// `extract`: walk the Pi session corpus and write weak-labelled replay cases.
// Cases land under ~/.pi/agent/pi-jev/replay/cases/ (outside the repo) because they
// contain verbatim session text. Only aggregate stats ever come back into the repo.

import { createWriteStream, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  OUT_ROOT, sessionFiles, forEachTurn, distinctiveLines, identifiers,
  type Ev, type Turn,
} from "./corpus.ts";
import {
  splitBlocks, matchesTool, loadTriageConfig, detectStructured, pickPrompt, TASK_NOTE_CHARS,
} from "../../extension/src/triage/core.ts";
import type { StructuredKind } from "../../extension/src/triage/structured.ts";

export type Feature = "triage";
export const FEATURES: Feature[] = ["triage"];

/** Cap the replayed result so one case cannot blow past Jev's per-request budget. */
export const MAX_STATE_CHARS = 120_000;
/** The shipped triage thresholds: which tools, how small a result to ignore, how many lines per block. */
export const TCFG = loadTriageConfig();
/** The extension skips results under three blocks: head and tail are pinned, so nothing is hideable. */
export const MIN_BLOCKS = 3;

export interface TriageCase {
  id: string; feature: "triage"; session: string; tool: string;
  bytes: number; truncated: boolean;
  /** What the extension's `skipStructured` guard would skip; kept here so the judge can be scored on it.
   *  Absent on cases extracted before the tag existed. */
  structured?: StructuredKind | null;
  task: { prompt: string; lastAssistant: string };
  /** `from`/`to`: char range within the line, only on pieces of a line longer than `blockChars`. */
  blocks: { i: number; startLine: number; endLine: number; chars: number; text: string; needed: boolean; from?: number; to?: number }[];
}
export type Case = TriageCase;

export const casePath = (f: Feature) => join(OUT_ROOT, "cases", `${f}.jsonl`);

// --- labelers (pure, tested in replay.test.ts) ---

/** Evidence accumulated from the messages that follow a tool result, within the same prompt turn. */
export interface Evidence { editLines: Set<string>; readPaths: string[]; finalIdents: Set<string> }

export function blockNeeded(blockText: string, ev: Evidence): boolean {
  for (const l of distinctiveLines(blockText)) if (ev.editLines.has(l)) return true;
  for (const p of ev.readPaths) {
    if (p.length >= 4 && blockText.includes(p)) return true;
    const b = p.slice(p.lastIndexOf("/") + 1);
    if (b.length >= 4 && blockText.includes(b)) return true;
  }
  if (ev.finalIdents.size) for (const id of identifiers(blockText)) if (ev.finalIdents.has(id)) return true;
  return false;
}

// --- per-turn extraction ---

/** Session so far, for the task text: every user prompt up to this turn (oldest first) and the
 *  latest assistant text before it, as the extension's `taskContext` sees the branch. */
export interface History { prompts: string[]; assistant: string }

export function extractTurn(session: string, t: Turn, sink: (c: TriageCase) => void, h: History = { prompts: [t.prompt], assistant: "" }): void {
  const evs = t.events;
  const callById = new Map<string, { name: string; args: Record<string, any> }>();
  for (const e of evs) if (e.r === "assistant") for (const c of e.calls) callById.set(c.id, { name: c.name, args: c.args });

  // Walk backwards so the "everything after this result" evidence set is built once per turn.
  const ev: Evidence = { editLines: new Set(), readPaths: [], finalIdents: new Set() };
  let sawFinalText = false;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.r === "toolResult") {
      const call = callById.get(e.callId);
      const tool = call?.name ?? e.name;
      if (!e.isError && matchesTool(tool, TCFG.tools) && e.text.length >= TCFG.minChars) {
        const truncated = e.text.length > MAX_STATE_CHARS;
        const raw = splitBlocks(e.text.slice(0, MAX_STATE_CHARS), TCFG.blockLines, 1, TCFG.blockChars);
        if (raw.length < MIN_BLOCKS) continue;
        const blocks = raw.map((b, i) => ({
          i, startLine: b.start, endLine: b.end, chars: b.text.length,
          text: b.text, needed: blockNeeded(b.text, ev),
          ...(b.from !== undefined && { from: b.from, to: b.to }),
        }));
        sink({
          id: `${session}#${t.index}#${e.callId}`, feature: "triage", session, tool,
          bytes: e.text.length, truncated, structured: detectStructured(e.text),
          task: { prompt: pickPrompt(h.prompts), lastAssistant: (prevAssistantText(evs, i) || h.assistant).trim().slice(-TASK_NOTE_CHARS) },
          blocks,
        });
      }
      continue;
    }
    if (e.r !== "assistant") continue;
    if (!sawFinalText && e.text.trim()) { for (const id of identifiers(e.text)) ev.finalIdents.add(id); sawFinalText = true; }
    for (const c of e.calls) {
      if (c.name === "edit") {
        const txt = `${c.args.oldText ?? c.args.old_text ?? ""}\n${c.args.newText ?? c.args.new_text ?? ""}`;
        for (const l of distinctiveLines(txt)) ev.editLines.add(l);
      } else if (c.name === "read") {
        const p = String(c.args.path ?? c.args.file_path ?? "");
        if (p) ev.readPaths.push(p);
      }
    }
  }
}

function prevAssistantText(evs: Ev[], i: number): string {
  for (let j = i - 1; j >= 0; j--) { const e = evs[j]; if (e.r === "assistant" && e.text.trim()) return e.text; }
  return "";
}

// --- driver ---

export interface ExtractStats {
  sessions: number; turns: number;
  triage: { cases: number; blocks: number; needed: number; resultBytes: number; truncated: number };
  caseBytes: Record<string, number>;
}

export async function runExtract(opts: { limit?: number }): Promise<ExtractStats> {
  mkdirSync(join(OUT_ROOT, "cases"), { recursive: true });
  const out = createWriteStream(casePath("triage"));
  const st: ExtractStats = {
    sessions: 0, turns: 0,
    triage: { cases: 0, blocks: 0, needed: 0, resultBytes: 0, truncated: 0 },
    caseBytes: { triage: 0 },
  };

  const sink = (c: TriageCase) => {
    st.triage.cases++; st.triage.blocks += c.blocks.length; st.triage.resultBytes += c.bytes;
    if (c.truncated) st.triage.truncated++;
    for (const b of c.blocks) if (b.needed) st.triage.needed++;
    const line = JSON.stringify(c) + "\n";
    st.caseBytes.triage += line.length;
    out.write(line); // ponytail: no backpressure; the producer is CPU-bound on JSON.parse, disk keeps up
  };

  let files = sessionFiles();
  if (opts.limit) files = files.slice(0, opts.limit);
  for (const f of files) {
    st.sessions++;
    const session = basename(f, ".jsonl");
    const h: History = { prompts: [], assistant: "" };
    try {
      await forEachTurn(f, t => {
        st.turns++;
        h.prompts.push(t.prompt);
        extractTurn(session, t, sink, h);
        h.assistant = prevAssistantText(t.events, t.events.length) || h.assistant;
      });
    }
    catch (e) { console.error(`  skip ${session}: ${(e as Error).message}`); }
    if (st.sessions % 100 === 0) console.error(`  ...${st.sessions}/${files.length} sessions`);
  }

  await new Promise<void>(res => out.end(() => res()));
  return st;
}
