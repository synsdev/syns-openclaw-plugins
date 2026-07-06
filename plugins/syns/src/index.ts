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
  /** Commit message for `syns push`. Falls back to $SYNS_PUSH_MESSAGE, then "openclaw session". */
  pushMessage?: string;
  /** Install the `syns` CLI on first use if it is missing. Default true. */
  installIfMissing?: boolean;
  /** Run `syns pull --if-repo` at the start of every turn. Default true. */
  pullOnTurnStart?: boolean;
  /** Run `syns push --if-repo` at the end of every turn. Default true. */
  pushOnTurnEnd?: boolean;
  /**
   * Working directory to run `syns` in — must be (or be inside) the Syns repo. Highest-priority
   * cwd source. Set this via `openclaw config set plugins.entries.syns.config.cwd "/path"`; it
   * survives `gateway restart`, unlike the SYNS_CWD env var. Default: auto-detected.
   */
  cwd?: string;
  /**
   * Path to the `syns` binary. Use an absolute path if `syns` is not on the gateway daemon's
   * PATH. Default "syns".
   */
  synsBin?: string;
  /** Log resolved cwd and every syns invocation to stderr (gateway log). Default false. */
  debug?: boolean;
}

interface Resolved {
  pushMessage: string;
  installIfMissing: boolean;
  pullOnTurnStart: boolean;
  pushOnTurnEnd: boolean;
  cwd: string;
  bin: string;
  debug: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolve(event: any): Resolved {
  const cfg = (event?.context?.pluginConfig ?? {}) as SynsConfig;
  return {
    pushMessage:
      str(cfg.pushMessage) ?? process.env.SYNS_PUSH_MESSAGE || "openclaw session",
    installIfMissing: cfg.installIfMissing ?? true,
    pullOnTurnStart: cfg.pullOnTurnStart ?? true,
    pushOnTurnEnd: cfg.pushOnTurnEnd ?? true,
    cwd: resolveCwd(event, str(cfg.cwd)),
    bin: str(cfg.synsBin) ?? "syns",
    debug: cfg.debug ?? false,
  };
}

/**
 * Resolve the working directory to run `syns` in. `--if-repo` resolves the repo identity from
 * the cwd (`.syns.yaml` in the tree), so this MUST be the session's working tree.
 *
 * Priority: explicit `config.cwd` -> $SYNS_CWD -> known event context fields -> process cwd.
 * OpenClaw doesn't document one canonical context field for conversation hooks, so we probe
 * candidates. The config option is the reliable knob (survives `gateway restart`).
 */
function resolveCwd(event: any, override?: string): string {
  const ctx = event?.context ?? {};
  const candidates = [
    override,
    process.env.SYNS_CWD,
    ctx.workspaceDir,
    ctx.cwd,
    ctx.ctx?.workspaceDir,
    ctx.config?.workspace?.dir,
    ctx.cfg?.workspace?.dir,
    process.env.OPENCLAW_WORKSPACE_DIR,
  ];
  for (const c of candidates) {
    const s = str(c);
    if (s) return s;
  }
  return process.cwd();
}

function dbg(debug: boolean, ...args: unknown[]): void {
  if (debug) console.error(LOG_PREFIX, ...args);
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

async function hasSyns(bin: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["--version"], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureSyns(r: Resolved): Promise<boolean> {
  if (synsReady) return true;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    if (await hasSyns(r.bin, r.cwd)) {
      synsReady = true;
      return true;
    }
    if (!r.installIfMissing || installAttempted) {
      dbg(r.debug, `syns not found (bin="${r.bin}") and install skipped.`);
      return false;
    }

    installAttempted = true;
    dbg(r.debug, "syns not found; running install.syns.dev/install.sh …");
    try {
      await execFileAsync(
        "sh",
        ["-c", "curl -fsSL https://install.syns.dev/install.sh | sh"],
        { cwd: r.cwd, timeout: 120_000 },
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} install failed:`, errText(err));
    }
    synsReady = await hasSyns(r.bin, r.cwd);
    if (!synsReady) {
      console.error(
        `${LOG_PREFIX} syns CLI not on PATH after install (bin="${r.bin}"); sync skipped ` +
          `(usable next process, or set config.synsBin to an absolute path).`,
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

async function runSyns(r: Resolved, args: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync(r.bin, args, { cwd: r.cwd, timeout: 60_000 });
    const out = String(stdout ?? "").trim();
    dbg(r.debug, `ok: syns ${args.join(" ")} (cwd=${r.cwd})${out ? ` | ${out}` : ""}`);
  } catch (err) {
    // --if-repo turns "not a Syns repo" into a silent exit 0, so anything that lands
    // here is a genuine failure (network, auth, server). Surface it, never throw.
    console.error(`${LOG_PREFIX} syns ${args.join(" ")} failed (cwd=${r.cwd}):`, errText(err));
  }
}

async function pull(r: Resolved): Promise<void> {
  dbg(r.debug, `before_agent_run -> pull (cwd=${r.cwd}, bin="${r.bin}")`);
  if (!(await ensureSyns(r))) return;
  await serialize(r.cwd, () => runSyns(r, ["pull", "--if-repo"]));
}

async function push(r: Resolved): Promise<void> {
  dbg(r.debug, `agent_end -> push (cwd=${r.cwd}, bin="${r.bin}")`);
  if (!(await ensureSyns(r))) return;
  await serialize(r.cwd, () => runSyns(r, ["push", "--if-repo", "-m", r.pushMessage]));
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
          const r = resolve(event);
          if (r.pullOnTurnStart) await pull(r);
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
          const r = resolve(event);
          if (r.pushOnTurnEnd) await push(r);
        } catch (err) {
          console.error(`${LOG_PREFIX} push hook error:`, errText(err));
        }
      },
      { priority: 0, timeoutMs: 60_000 },
    );
  },
});
