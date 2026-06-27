/**
 * Syns plugin for OpenClaw.
 *
 * Per-turn auto-sync of a Syns repository:
 *   - before_agent_run  ->  `syns pull --if-repo`   (refresh the working tree before the model runs)
 *   - agent_end         ->  `syns push --if-repo -m <msg>`  (commit the working tree after each turn)
 *
 * Both hooks are scoped by the CLI's `--if-repo` flag: outside a Syns repo (a directory
 * with a `.syns.yaml`) every invocation is a silent exit-0 no-op. The plugin never blocks
 * or fails a turn — pull/push errors are logged and swallowed.
 *
 * Unlike the Claude Code / Codex ports (pull once at session start, push per turn), this
 * port pulls AND pushes on every turn, by request.
 *
 * Requirements:
 *   - Node 22.19+ (OpenClaw runtime).
 *   - `before_agent_run` and `agent_end` are raw-conversation hooks, so a non-bundled
 *     plugin must be granted conversation access in the gateway config:
 *       plugins.entries.syns.hooks.allowConversationAccess = true
 *     Without it these hooks never fire. See README.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOG_PREFIX = "[syns]";

interface SynsConfig {
  /** Commit message for `syns push`. Falls back to "openclaw session". */
  pushMessage?: string;
  /** Install the `syns` CLI on first use if it is missing. Default true. */
  installIfMissing?: boolean;
  /** Run `syns pull --if-repo` at the start of every turn. Default true. */
  pullOnTurnStart?: boolean;
  /** Run `syns push --if-repo` at the end of every turn. Default true. */
  pushOnTurnEnd?: boolean;
}

const DEFAULTS: Required<SynsConfig> = {
  pushMessage: "openclaw session",
  installIfMissing: true,
  pullOnTurnStart: true,
  pushOnTurnEnd: true,
};

function resolveConfig(event: any): Required<SynsConfig> {
  const cfg = (event?.context?.pluginConfig ?? {}) as SynsConfig;
  return {
    pushMessage:
      typeof cfg.pushMessage === "string" && cfg.pushMessage.length > 0
        ? cfg.pushMessage
        : process.env.SYNS_PUSH_MESSAGE || DEFAULTS.pushMessage,
    installIfMissing: cfg.installIfMissing ?? DEFAULTS.installIfMissing,
    pullOnTurnStart: cfg.pullOnTurnStart ?? DEFAULTS.pullOnTurnStart,
    pushOnTurnEnd: cfg.pushOnTurnEnd ?? DEFAULTS.pushOnTurnEnd,
  };
}

/**
 * Resolve the working directory to run `syns` in. `--if-repo` resolves the repo identity
 * from the cwd (`.syns.yaml` in the tree), so this MUST be the session's working tree.
 *
 * OpenClaw does not document a single canonical field for this on conversation hooks, so we
 * probe the known candidates in order and fall back to the process cwd. Confirm the real
 * field against a live gateway and tighten this. (Open question in PLAN.md.)
 *
 * `SYNS_CWD` is an explicit, deterministic override that always wins — set it to the repo
 * path to make sync work regardless of how OpenClaw exposes the working directory.
 */
function resolveCwd(event: any): string {
  const ctx = event?.context ?? {};
  const candidates = [
    process.env.SYNS_CWD,
    ctx.workspaceDir,
    ctx.cwd,
    ctx.ctx?.workspaceDir,
    ctx.config?.workspace?.dir,
    ctx.cfg?.workspace?.dir,
    process.env.OPENCLAW_WORKSPACE_DIR,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Install-if-missing. The PATH presence is re-checked cheaply each call (PATH may
// gain `syns` between processes), but the install script is attempted at most ONCE
// per process — install.sh edits the shell rc, not this process's PATH, so retrying
// it within the same process is pointless and slow.
// ---------------------------------------------------------------------------
let synsReady = false; // true once `syns --version` has succeeded this process
let installAttempted = false; // install script tried once this process
let ensureInFlight: Promise<boolean> | null = null;

async function hasSyns(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("syns", ["--version"], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureSyns(cwd: string, installIfMissing: boolean): Promise<boolean> {
  if (synsReady) return true;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    if (await hasSyns(cwd)) {
      synsReady = true;
      return true;
    }
    if (!installIfMissing || installAttempted) return false;

    installAttempted = true;
    try {
      await execFileAsync(
        "sh",
        ["-c", "curl -fsSL https://install.syns.dev/install.sh | sh"],
        { cwd, timeout: 120_000 },
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} install failed:`, errText(err));
    }
    synsReady = await hasSyns(cwd);
    if (!synsReady) {
      console.error(
        `${LOG_PREFIX} syns CLI not on PATH after install; sync skipped (usable next process).`,
      );
    }
    return synsReady;
  })();

  try {
    return await ensureInFlight;
  } finally {
    ensureInFlight = null;
  }
}

// ---------------------------------------------------------------------------
// Per-cwd serialization: a slow push from turn N must not overlap the pull of
// turn N+1 on persistent-gateway paths where agent_end runs fire-and-forget.
// ---------------------------------------------------------------------------
const locks = new Map<string, Promise<unknown>>();

function serialize<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(cwd) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // keep the chain alive but don't let a rejection poison the next link
  locks.set(
    cwd,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const s = String((err as any).stderr ?? "").trim();
    if (s) return s;
  }
  return err instanceof Error ? err.message : String(err);
}

async function runSyns(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("syns", args, { cwd, timeout: 60_000 });
  } catch (err) {
    // --if-repo turns "not a Syns repo" into a silent exit 0, so anything that lands
    // here is a genuine failure (network, auth, server). Surface it, never throw.
    console.error(`${LOG_PREFIX} syns ${args.join(" ")} failed:`, errText(err));
  }
}

async function pull(event: any, cfg: Required<SynsConfig>): Promise<void> {
  const cwd = resolveCwd(event);
  if (!(await ensureSyns(cwd, cfg.installIfMissing))) return;
  await serialize(cwd, () => runSyns(cwd, ["pull", "--if-repo"]));
}

async function push(event: any, cfg: Required<SynsConfig>): Promise<void> {
  const cwd = resolveCwd(event);
  if (!(await ensureSyns(cwd, cfg.installIfMissing))) return;
  await serialize(cwd, () => runSyns(cwd, ["push", "--if-repo", "-m", cfg.pushMessage]));
}

export default definePluginEntry({
  id: "syns",
  name: "Syns",
  description:
    "Per-turn auto-pull and auto-push of a Syns repository, scoped to directories containing a .syns.yaml.",
  register(api: any) {
    // Turn start -> pull. before_agent_run is a blocking conversation hook; we only do a
    // side effect and always return a pass outcome so a pull failure can never block the turn.
    api.on(
      "before_agent_run",
      async (event: any) => {
        try {
          const cfg = resolveConfig(event);
          if (cfg.pullOnTurnStart) await pull(event, cfg);
        } catch (err) {
          console.error(`${LOG_PREFIX} pull hook error:`, errText(err));
        }
        return { outcome: "pass" };
      },
      { priority: 0, timeoutMs: 90_000 },
    );

    // Turn end -> push. agent_end is observation-only; awaited on one-shot CLI paths,
    // fire-and-forget on gateway paths (serialize() guards against overlap there).
    api.on(
      "agent_end",
      async (event: any) => {
        try {
          const cfg = resolveConfig(event);
          if (cfg.pushOnTurnEnd) await push(event, cfg);
        } catch (err) {
          console.error(`${LOG_PREFIX} push hook error:`, errText(err));
        }
      },
      { priority: 0, timeoutMs: 60_000 },
    );
  },
});
