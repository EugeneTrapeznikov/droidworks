import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_NAME = "pi-update";
const STATE_DIR = join(homedir(), ".pi", "agent", "pi-update");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOCK_FILE = join(STATE_DIR, "update.lock");
const OUTPUT_FILE = join(STATE_DIR, "last-command.log");

/** The Droidworks `pi` patcher next to this extension in the same checkout. */
export function resolveDefaultPatcher(moduleUrl = import.meta.url) {
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  return resolve(dirname(modulePath), "..", "pi", "scripts", "apply-installed-patches.py");
}

const DEFAULT_PI_PATCHER = resolveDefaultPatcher();

const DEFAULT_INTERVAL_HOURS = 0;
const DEFAULT_START_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024;

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  ensureStateDir();
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function formatAge(timestamp) {
  if (!timestamp) return "never";
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 48 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}

function shouldRun(state) {
  const intervalMs = envNumber("PI_UPDATE_INTERVAL_HOURS", DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000;
  if (process.env.PI_UPDATE_FORCE === "1") return true;
  if (state.lastStatus === "failed" || state.lastStatus === "running") return true;
  if (intervalMs === 0) return true;

  const lastAttemptAt = Number(state.lastAttemptAt ?? 0);
  return !lastAttemptAt || Date.now() - lastAttemptAt >= intervalMs;
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  ensureStateDir();

  if (existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      const ageMs = Date.now() - Number(lock.startedAt ?? 0);
      if (ageMs < DEFAULT_TIMEOUT_MS * 2 && isProcessAlive(Number(lock.pid))) {
        return { ok: false, reason: `another update is running (pid ${lock.pid})` };
      }
    } catch {}

    try {
      unlinkSync(LOCK_FILE);
    } catch {}
  }

  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
    return { ok: true };
  } catch {
    return { ok: false, reason: "another update started first" };
  }
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
}

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

// The child runs in its own process group with output in a file, so quitting
// Pi mid-update neither signals it nor breaks its stdout: `pi update` can
// replace the installed package, and npm killed halfway leaves no `pi` binary.
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    ensureStateDir();
    const output = openSync(OUTPUT_FILE, "w");
    const child = spawn(command, args, {
      cwd: homedir(),
      detached: true,
      env: {
        ...process.env,
        PI_UPDATE_EXTENSION_CHILD: "1",
      },
      stdio: ["ignore", output, output],
    });
    closeSync(output);
    const readOutput = () => {
      try {
        stdout = appendBounded("", readFileSync(OUTPUT_FILE, "utf8"));
      } catch {}
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      readOutput();
      resolve({ code: -1, stdout, stderr: appendBounded(stderr, error.message), timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      readOutput();
      resolve({ code: code ?? -1, signal, stdout, stderr, timedOut });
    });
  });
}

function updateStatus(ctx, text) {
  try {
    ctx.ui.setStatus(EXTENSION_NAME, text);
  } catch {}
}

function notify(ctx, message, level = "info") {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.notify(message, level);
  } catch {}
}

function outputSummary(result) {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (!combined) return "";
  const lines = combined.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-8).join("\n");
}

async function runPiUpdate(ctx, { manual = false } = {}) {
  if (process.env.PI_UPDATE_DISABLED === "1") {
    if (manual) notify(ctx, "pi-update is disabled by PI_UPDATE_DISABLED=1", "warning");
    return;
  }

  if (process.env.PI_UPDATE_EXTENSION_CHILD === "1") return;

  const lock = acquireLock();
  if (!lock.ok) {
    if (manual) notify(ctx, `pi update skipped: ${lock.reason}`, "warning");
    return;
  }

  const startedAt = Date.now();
  writeState({ lastAttemptAt: startedAt, lastStatus: "running" });
  updateStatus(ctx, "pi update: checking…");

  const command = process.env.PI_UPDATE_COMMAND || "pi";
  const args = (process.env.PI_UPDATE_ARGS || "update --all --no-approve").split(/\s+/).filter(Boolean);
  const timeoutMs = envNumber("PI_UPDATE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  try {
    const result = await runCommand(command, args, timeoutMs);
    const updateSucceeded = result.code === 0 && !result.timedOut;
    const patcher = process.env.PI_UPDATE_PATCHER || DEFAULT_PI_PATCHER;
    const patchResult = !updateSucceeded
      ? undefined
      : !existsSync(patcher)
        ? { code: -1, stdout: "", stderr: `Pi patcher not found: ${patcher}`, timedOut: false }
        : await runCommand("python3", [patcher], timeoutMs);
    const patchSucceeded = patchResult === undefined || (patchResult.code === 0 && !patchResult.timedOut);
    const finishedAt = Date.now();
    const summary = [outputSummary(result), patchResult ? outputSummary(patchResult) : ""].filter(Boolean).join("\n");
    const success = updateSucceeded && patchSucceeded;
    const status = !updateSucceeded ? "failed" : !patchSucceeded ? "patch-failed" : "ok";

    writeState({
      lastFinishedAt: finishedAt,
      lastDurationMs: finishedAt - startedAt,
      lastExitCode: success ? 0 : (patchResult?.code ?? result.code),
      lastUpdateExitCode: result.code,
      lastPatchExitCode: patchResult?.code,
      lastSignal: patchResult?.signal ?? result.signal,
      lastTimedOut: result.timedOut || Boolean(patchResult?.timedOut),
      lastStatus: status,
      lastSummary: summary,
      lastCommand: [command, ...args].join(" "),
      lastPatcher: patcher,
      ...(success ? { lastSuccessAt: finishedAt } : {}),
    });

    if (success) {
      updateStatus(ctx, "pi update: ok");
      if (manual || process.env.PI_UPDATE_NOTIFY_SUCCESS === "1") {
        notify(ctx, `pi update and patch completed${summary ? `\n${summary}` : ""}`, "info");
      }
    } else {
      updateStatus(ctx, "pi update: failed");
      const failedStep = updateSucceeded ? "Pi patch reapplication" : "pi update";
      notify(ctx, `${failedStep} failed${result.timedOut || patchResult?.timedOut ? " (timed out)" : ""}${summary ? `\n${summary}` : ""}`, "error");
    }
  } finally {
    releaseLock();
    setTimeout(() => updateStatus(ctx, undefined), 5000).unref?.();
  }
}

function statusText() {
  const state = readState();
  const lastStatus = state.lastStatus ?? "never run";
  const lastAttempt = formatAge(state.lastAttemptAt);
  const lastSuccess = formatAge(state.lastSuccessAt);
  const lastExitCode = state.lastExitCode ?? "n/a";
  const next = shouldRun(state) ? "next startup" : "after throttle interval";

  return [
    `pi-update: ${lastStatus}`,
    `last attempt: ${lastAttempt}`,
    `last success: ${lastSuccess}`,
    `last exit code: ${lastExitCode}`,
    `next automatic run: ${next}`,
    state.lastSummary ? `last output:\n${state.lastSummary}` : undefined,
  ].filter(Boolean).join("\n");
}

export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    if (ctx.mode !== "tui") return;
    if (process.env.PI_UPDATE_EXTENSION_CHILD === "1") return;
    if (process.env.PI_UPDATE_DISABLED === "1") return;

    const state = readState();
    if (!shouldRun(state)) return;

    const delayMs = envNumber("PI_UPDATE_START_DELAY_MS", DEFAULT_START_DELAY_MS);
    setTimeout(() => {
      void runPiUpdate(ctx, { manual: false });
    }, delayMs).unref?.();
  });

  pi.registerCommand("pi-update", {
    description: "Run `pi update --all` now, show status, or reset recorded state",
    handler: async (args, ctx) => {
      const action = (args || "now").trim().toLowerCase();

      if (action === "status") {
        notify(ctx, statusText(), "info");
        return;
      }

      if (action === "reset") {
        try {
          unlinkSync(STATE_FILE);
        } catch {}
        notify(ctx, "pi-update state reset", "info");
        return;
      }

      await runPiUpdate(ctx, { manual: true });
    },
  });
}
