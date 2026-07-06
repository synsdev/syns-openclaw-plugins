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
 *
 * Config vs env vars (IMPORTANT):
 *   On the persistent gateway path, `event.context.pluginConfig` is not reliably
 *   populated for these hooks — it can arrive as null. So `plugins.entries.syns.config.*`
 *   values (cwd, synsBin, ...) may NOT reach the running hook. The reliable knobs are
 *   environment variables set on the gateway service env, plus robust auto-detection:
 *     - SYNS_CWD           -> the Syns repo working directory (REQUIRED unless the
 *                             gateway's own cwd is already inside the repo)
 *     - SYNS_PUSH_MESSAGE  -> commit message (optional)
 *   The binary is auto-located across PATH + ~/.cargo/bin + ~/.local/bin + the usual
 *   Homebrew/local prefixes, with a HOME fallback for bare launchd environments, so
 *   `synsBin` config is normally unnecessary. See README § Setup.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";

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
   * Working directory to run `syns` in — must be (or be inside) the Syns repo.
   * NOTE: config injection is unreliable on the gateway hook path (see file header);
   * prefer the SYNS_CWD env var, which is the primary cwd source in practice.
   * Default: auto-detected from event/env, else process cwd.
   */
  cwd?: string;
  /**
   * Path to the `syns` binary. Normally unnecessary — the plugin auto-locates syns across
   * PATH, ~/.cargo/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin. Set an absolute
   * path only for a non-standard install. (Also subject to the config-injection caveat.)
   */
  synsBin?: string;
}

interface Resolved {
  pushMessage: string;
  installIfMissing: boolean;
  pullOnTurnStart: boolean;
  pushOnTurnEnd: boolean;
  cwd: string;
  bin: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolve(event: any): Resolved {
  const cfg = (event?.context?.pluginConfig ?? {}) as SynsConfig;
  return {
    pushMessage:
      str(cfg.pushMessage) ?? (process.env.SYNS_PUSH_MESSAGE || "openclaw session"),
    installIfMissing: cfg.installIfMissing ?? true,
    pullOnTurnStart: cfg.pullOnTurnStart ?? true,
    pushOnTurnEnd: cfg.pushOnTurnEnd ?? true,
    cwd: resolveCwd(event, str(cfg.cwd)),
    bin: str(cfg.synsBin) ?? "syns",
  };
}

/**
 * Resolve the working directory to run `syns` in. `--if-repo` resolves the repo identity from
 * the cwd (`.syns.yaml` in the tree), so this MUST be the session's working tree.
 *
 * Priority: explicit `config.cwd` (if it arrives) -> $SYNS_CWD -> known event context
 * fields -> process cwd. In practice SYNS_CWD is the reliable knob because pluginConfig
 * is often null on the gateway hook path; OpenClaw also doesn't expose one canonical
 * workspace field for conversation hooks, so we probe several candidates.
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

// ---------------------------------------------------------------------------
// Locate the `syns` binary. The gateway daemon often runs with a minimal PATH
// (launchd/Homebrew) that omits ~/.cargo/bin etc., so a bare "syns" fails even when
// the user's shell has it. When config.synsBin isn't an explicit path, we probe the
// common install locations. The install script is attempted at most ONCE per process
// (install.sh edits the shell rc, not this process's PATH). The resolved absolute
// path is cached for the process.
// ---------------------------------------------------------------------------
let effectiveBin: string | null = null; // resolved usable binary path/name
let installAttempted = false;
let ensureInFlight: Promise<string | null> | null = null;

function resolveHome(): string {
  // Gateway daemons (launchd) may run with an empty/unset HOME. Fall back to the
  // OS user-info home so ~/.cargo/bin resolution still works under a bare env.
  const fromEnv = process.env.HOME || process.env.USERPROFILE || "";
  if (fromEnv) return fromEnv;
  try {
    return userInfo().homedir || homedir() || "";
  } catch {
    try {
      return homedir() || "";
    } catch {
      return "";
    }
  }
}

function candidateBins(bin: string): string[] {
  if (bin !== "syns") return [bin]; // explicit path/name from config — respect it
  const home = resolveHome();
  return [
    "syns", // whatever PATH the daemon does have
    home && `${home}/.cargo/bin/syns`,
    home && `${home}/.local/bin/syns`,
    "/usr/local/bin/syns",
    "/opt/homebrew/bin/syns",
  ].filter((b): b is string => Boolean(b));
}

async function hasSyns(bin: string, cwd: string): Promise<boolean> {
  try {
    // Probe with `--help` (exit 0), NOT `--version`: the syns CLI is subcommand-only
    // and rejects `--version`/`-V` with a non-zero exit, which would make detection fail.
    await execFileAsync(bin, ["--help"], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function findSyns(r: Resolved): Promise<string | null> {
  for (const b of candidateBins(r.bin)) {
    if (await hasSyns(b, r.cwd)) return b;
  }
  return null;
}

/** Returns a usable `syns` binary path, or null if unavailable. Cached per process. */
async function ensureSyns(r: Resolved): Promise<string | null> {
  if (effectiveBin) return effectiveBin;
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    let found = await findSyns(r);
    if (found) {
      effectiveBin = found;
      return found;
    }
    if (!r.installIfMissing || installAttempted) return null;

    installAttempted = true;
    try {
      await execFileAsync(
        "sh",
        ["-c", "curl -fsSL https://install.syns.dev/install.sh | sh"],
        { cwd: r.cwd, timeout: 120_000 },
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} install failed:`, errText(err));
    }
    found = await findSyns(r);
    if (found) {
      effectiveBin = found;
    } else {
      console.error(
        `${LOG_PREFIX} syns CLI not found after install (bin="${r.bin}"); sync skipped ` +
          `(usable next process, or set config.synsBin to an absolute path).`,
      );
    }
    return found;
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

async function runSyns(bin: string, r: Resolved, args: string[]): Promise<void> {
  try {
    await execFileAsync(bin, args, { cwd: r.cwd, timeout: 60_000 });
  } catch (err) {
    // --if-repo turns "not a Syns repo" into a silent exit 0, so anything that lands
    // here is a genuine failure (network, auth, server). Surface it, never throw.
    console.error(`${LOG_PREFIX} syns ${args.join(" ")} failed (cwd=${r.cwd}):`, errText(err));
  }
}

async function pull(r: Resolved): Promise<void> {
  const bin = await ensureSyns(r);
  if (!bin) return;
  await serialize(r.cwd, () => runSyns(bin, r, ["pull", "--if-repo"]));
}

async function push(r: Resolved): Promise<void> {
  const bin = await ensureSyns(r);
  if (!bin) return;
  await serialize(r.cwd, () => runSyns(bin, r, ["push", "--if-repo", "-m", r.pushMessage]));
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
