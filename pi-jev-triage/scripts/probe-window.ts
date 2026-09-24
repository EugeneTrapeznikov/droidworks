// Pi extension: dump the first-turn context window for measurement.
// Usage: PI_JEV_PROBE_OUT=/tmp/probe pi -p "reply with the single word ok"
// Writes <out>.json (system prompt sections, skills, tool schemas by source package)
// and <out>.context.jsonl (exact message array sent to the provider).
import { writeFileSync, appendFileSync } from "node:fs";

const OUT = process.env.PI_JEV_PROBE_OUT ?? "./pi-jev-probe";

export default function (pi: any) {
  let done = false;
  pi.on("before_agent_start", async (ev: any) => {
    if (done) return;
    done = true;
    const o = ev.systemPromptOptions ?? {};
    const tools = (pi.getAllTools?.() ?? []).map((t: any) => ({
      name: t.name,
      source: t.sourceInfo?.source,
      schemaChars: JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length,
    }));
    const active = new Set(pi.getActiveTools?.() ?? []);
    const bySource: Record<string, number> = {};
    for (const t of tools) if (active.has(t.name)) bySource[t.source ?? "builtin"] = (bySource[t.source ?? "builtin"] ?? 0) + t.schemaChars;
    writeFileSync(`${OUT}.json`, JSON.stringify({
      prompt: ev.prompt,
      systemPromptChars: (ev.systemPrompt ?? "").length,
      systemPrompt: ev.systemPrompt,
      sectionChars: Object.fromEntries(Object.entries(o.sections ?? {}).map(([k, v]: any) => [k, String(v).length])),
      contextFiles: (o.contextFiles ?? []).map((c: any) => ({ path: c.path, chars: c.content.length })),
      skills: (o.skills ?? []).map((s: any) => ({ name: s.name, descChars: (s.description ?? "").length, source: s.sourceInfo?.source })),
      selectedTools: o.selectedTools ?? [],
      activeTools: [...active],
      tools,
      activeSchemaCharsBySource: bySource,
      activeSchemaChars: Object.values(bySource).reduce((a, b) => a + b, 0),
    }, null, 2));
  });

  let ctxDumped = false;
  pi.on("context_with_system", async (ev: any) => {
    if (ctxDumped) return;
    ctxDumped = true;
    appendFileSync(`${OUT}.context.jsonl`, JSON.stringify({ kind: "context_with_system", messages: ev.messages }) + "\n");
  });
}
