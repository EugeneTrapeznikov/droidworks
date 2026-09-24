// Pi session corpus reader + the weak-label text helpers.
// Block splitting, tool matching and the triage decision policy are imported from
// extension/src/triage/core.ts, so replay scores the policy that actually ships.

import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSIONS_ROOT = process.env.PI_JEV_SESSIONS ?? join(homedir(), ".pi/agent/sessions");
export const OUT_ROOT = process.env.PI_JEV_REPLAY ?? join(homedir(), ".pi/agent/pi-jev/replay");

export function sessionFiles(root = SESSIONS_ROOT, minBytes = 50_000): string[] {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(root, d, f);
      try { if (statSync(p).size > minBytes) out.push(p); } catch { /* vanished */ }
    }
  }
  return out.sort();
}

export type ToolCall = { id: string; name: string; args: Record<string, any> };
export type Ev =
  | { r: "user"; text: string }
  | { r: "assistant"; text: string; calls: ToolCall[] }
  | { r: "toolResult"; callId: string; name: string; text: string; isError: boolean };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const c of content) if (c && typeof c === "object" && (c as any).type === "text") s += (c as any).text ?? "";
  return s;
}

function parseArgs(a: unknown): Record<string, any> {
  if (a && typeof a === "object") return a as Record<string, any>;
  if (typeof a === "string") { try { return JSON.parse(a); } catch { return { _raw: a }; } }
  return {};
}

function toEvent(msg: any): Ev | null {
  switch (msg?.role) {
    case "user":
      return { r: "user", text: blockText(msg.content) };
    case "assistant": {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const calls: ToolCall[] = [];
      for (const c of content) {
        if (c?.type === "toolCall") calls.push({ id: c.id ?? "", name: c.name ?? "", args: parseArgs(c.arguments) });
      }
      return { r: "assistant", text: blockText(msg.content), calls };
    }
    case "toolResult":
      return {
        r: "toolResult",
        callId: msg.toolCallId ?? "",
        name: msg.toolName ?? "",
        text: blockText(msg.content),
        isError: !!msg.isError,
      };
    default:
      return null;
  }
}

/** A prompt turn: one user message and everything up to the next user message. */
export interface Turn { index: number; prompt: string; events: Ev[] }

/**
 * Walk one session file in write order (matching scripts/mine-sessions.py; branches are
 * replayed as recorded rather than resolved through parentId) and yield prompt turns.
 */
export async function forEachTurn(path: string, cb: (t: Turn) => void | Promise<void>): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let cur: Turn | null = null;
  let index = 0;

  const flush = async () => { if (cur) { await cb(cur); cur = null; } };

  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "message") continue;
    const ev = toEvent(e.message);
    if (!ev) continue;
    if (ev.r === "user") {
      await flush();
      cur = { index: index++, prompt: ev.text, events: [] };
      continue;
    }
    if (cur) cur.events.push(ev);
  }
  await flush();
}

// --- weak-label text helpers ---

/** Lines distinctive enough to be evidence of reuse: >=20 chars, not whitespace/braces only. */
export function distinctiveLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (t.length < 20) continue;
    if (t.replace(/[{}()\[\];,\s]/g, "").length === 0) continue;
    out.push(t);
  }
  return out;
}

const IDENT_RE = /[A-Za-z0-9_./-]{8,}/g;
/** Identifiers distinctive enough that quoting one means the block was used. */
export function identifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(IDENT_RE) ?? []) {
    if (!/[A-Za-z]/.test(m)) continue;
    if (!(/[_./-]/.test(m) || /[a-z][A-Z]/.test(m))) continue;
    out.push(m);
  }
  return out;
}

