// Runtime secret loading. The key is read by the extension process and handed to fetch;
// it is never logged, never returned to a caller other than the judge constructor.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const DEFAULT_ENV_FILES = [`${homedir()}/.config/vercel/.env`, `${homedir()}/.config/typesafe/.env`];

/** Return `name` from env, else from the first env file that defines it. Files listed in PI_JEV_ENV_FILES (colon-separated) come first. */
export function secret(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env[name]) return env[name];
  const files = [...(env.PI_JEV_ENV_FILES ?? "").split(":").filter(Boolean), ...DEFAULT_ENV_FILES];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).replace(/^export\s+/, "").trim();
      if (k !== name) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) return v;
    }
  }
  return undefined;
}
