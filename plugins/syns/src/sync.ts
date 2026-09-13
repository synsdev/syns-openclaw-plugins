/**
 * The Syns side of the OpenClaw plugin, kept free of the Plugin SDK so it can be
 * tested on its own. It runs `syns pull` and `syns sync` — the commands a person
 * runs — and maps their exit code to OpenClaw and nothing more:
 * - 0 (synced, no changes, not a Syns folder) adds nothing and logs nothing;
 * - 4 (resolution required) continues the agent with the CLI's own output;
 * - anything else is logged with the CLI's own line, and never continues it.
 * SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER default to `openclaw`, the session
 * and `start`/`finish` wherever the gateway environment has not set them.
 */

import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";

export const INTEGRATION = "openclaw";
export const RESOLUTION_REQUIRED = 4;

const PULL_TIMEOUT_MS = 120_000;
const SYNC_TIMEOUT_MS = 280_000;
const INSTALL_TIMEOUT_MS = 120_000;
const INSTALL_COMMAND = "curl -fsSL https://install.syns.dev/install.sh | sh";
const REMEMBERED = 500;

export interface CommandResult {
  code: number;
  output: string;
}

export interface ExecOptions {
  cwd: string;
  timeout: number;
  env?: NodeJS.ProcessEnv;
}

export type Exec = (command: string, args: string[], options: ExecOptions) => Promise<CommandResult>;

export const execCommand: Exec = (command, args, { cwd, timeout, env }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout, env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (!error) {
          resolve({ code: 0, output });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: number | string };
        const code = typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1;
        resolve({ code, output: output || failure.message });
      },
    );
  });

/** The home directory, falling back to the OS user record for bare daemon environments. */
export function resolveHome(): string {
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remember(set: Set<string>, value: string): void {
  set.add(value);
  for (const oldest of set) {
    if (set.size <= REMEMBERED) break;
    set.delete(oldest);
  }
}

function pendingBeforeNewWork(output: string): string {
  return `A Syns resolution is pending in this folder. Finish it before new work.\n\n${output}`;
}

export interface SynsConfig {
  /** Install the `syns` CLI on first use if it is missing. Default true. */
  installIfMissing?: boolean;
  /** Run `syns pull --if-repo` before every agent turn. Default true. */
  pullOnTurnStart?: boolean;
  /** Run `syns sync --if-repo` when every agent turn finishes. Default true. */
  syncOnTurnEnd?: boolean;
  /** @deprecated The earlier name of `syncOnTurnEnd`, still read where that is unset. */
  pushOnTurnEnd?: boolean;
  /** Working directory to run `syns` in — the Syns repository. */
  cwd?: string;
  /** Path to the `syns` binary, for a non-standard install. */
  synsBin?: string;
}

/** The fields of OpenClaw's agent hook context this plugin reads. */
export interface HookContext {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

export interface FinalizeEvent {
  runId?: string;
  cwd?: string;
}

export interface NextTurnInjection {
  sessionKey: string;
  text: string;
  placement?: "prepend_context" | "append_context";
}

export interface SynsHost {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  home(): string;
  cwd(): string;
  info(message: string): void;
  warn(message: string): void;
  enqueueNextTurnInjection?: (injection: NextTurnInjection) => Promise<unknown>;
}

export function createSyns(config: SynsConfig, host: SynsHost) {
  const installIfMissing = config.installIfMissing ?? true;
  const pullOnTurnStart = config.pullOnTurnStart ?? true;
  const syncOnTurnEnd = config.syncOnTurnEnd ?? config.pushOnTurnEnd ?? true;
  const bin = text(config.synsBin) ?? "syns";

  let effectiveBin: string | null = null;
  let installAttempted = false;
  let ensureInFlight: Promise<string | null> | null = null;
  const locks = new Map<string, Promise<unknown>>();
  const finalized = new Set<string>();

  function cwdFor(ctx: HookContext, eventCwd?: unknown): string {
    for (const candidate of [config.cwd, host.env.SYNS_CWD, ctx.workspaceDir, eventCwd, host.env.OPENCLAW_WORKSPACE_DIR]) {
      const value = text(candidate);
      if (value) return value;
    }
    return host.cwd();
  }

  function candidateBins(): string[] {
    if (bin !== "syns") return [bin];
    const home = host.home();
    return [
      "syns",
      home && `${home}/.cargo/bin/syns`,
      home && `${home}/.local/bin/syns`,
      "/usr/local/bin/syns",
      "/opt/homebrew/bin/syns",
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  async function findSyns(cwd: string): Promise<string | null> {
    for (const candidate of candidateBins()) {
      if ((await host.exec(candidate, ["--help"], { cwd, timeout: 10_000 })).code === 0) return candidate;
    }
    return null;
  }

  /** A usable `syns` binary — the gateway's PATH is often short — installed at most once per process. */
  async function ensureSyns(cwd: string): Promise<string | null> {
    if (effectiveBin) return effectiveBin;
    if (ensureInFlight) return ensureInFlight;
    ensureInFlight = (async () => {
      let found = await findSyns(cwd);
      if (!found && installIfMissing && !installAttempted) {
        installAttempted = true;
        const install = await host.exec("sh", ["-c", INSTALL_COMMAND], { cwd, timeout: INSTALL_TIMEOUT_MS });
        found = await findSyns(cwd);
        if (!found) {
          host.warn(`the Syns CLI is not installed and could not be installed (${install.output || `exit code ${install.code}`}); pull and sync are skipped.`);
        }
      }
      effectiveBin = found;
      return found;
    })();
    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  /** One CLI run at a time per working directory: a slow sync never overlaps the next turn's pull. */
  function serialize<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(cwd) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(cwd, next.then(() => undefined, () => undefined));
    return next;
  }

  async function runSyns(verb: "pull" | "sync", ctx: HookContext, cwd: string): Promise<CommandResult | null> {
    const executable = await ensureSyns(cwd);
    if (!executable) return null;
    const env: NodeJS.ProcessEnv = {
      ...host.env,
      SYNS_INTEGRATION: text(host.env.SYNS_INTEGRATION) ?? INTEGRATION,
      SYNS_RUN: text(host.env.SYNS_RUN) ?? text(ctx.sessionId) ?? text(ctx.sessionKey) ?? "",
      SYNS_TRIGGER: text(host.env.SYNS_TRIGGER) ?? (verb === "pull" ? "start" : "finish"),
    };
    return serialize(cwd, () => host.exec(executable, [verb, "--if-repo"], {
      cwd,
      timeout: verb === "pull" ? PULL_TIMEOUT_MS : SYNC_TIMEOUT_MS,
      env,
    }));
  }

  /** `agent_turn_prepare`: pull, prepending a pending resolution to the turn. */
  async function turnPrepare(_event: unknown, ctx: HookContext = {}): Promise<{ prependContext: string } | undefined> {
    if (!pullOnTurnStart) return undefined;
    try {
      const result = await runSyns("pull", ctx, cwdFor(ctx));
      if (!result || result.code === 0) return undefined;
      if (result.code === RESOLUTION_REQUIRED) return { prependContext: pendingBeforeNewWork(result.output) };
      host.warn(`syns pull: ${result.output}`);
    } catch (error) {
      host.warn(`pull hook error: ${errorText(error)}`);
    }
    return undefined;
  }

  /** `before_agent_finalize`: sync, sending the agent back only where a resolution is required. */
  async function beforeAgentFinalize(
    event: FinalizeEvent = {},
    ctx: HookContext = {},
  ): Promise<{ action: "revise"; reason: string } | undefined> {
    if (!syncOnTurnEnd) return undefined;
    const runId = text(event.runId) ?? text(ctx.runId);
    if (runId) remember(finalized, runId);
    try {
      const result = await runSyns("sync", ctx, cwdFor(ctx, event.cwd));
      if (!result || result.code === 0) return undefined;
      if (result.code === RESOLUTION_REQUIRED) return { action: "revise", reason: result.output };
      host.warn(`syns sync: ${result.output}`);
    } catch (error) {
      host.warn(`sync hook error: ${errorText(error)}`);
    }
    return undefined;
  }

  /**
   * `agent_end`: sync a turn no `before_agent_finalize` saw. It can only observe, so a
   * resolution is left to the next turn — its pull, or a next-turn injection where
   * pulling before turns is off.
   */
  async function agentEnd(event: { runId?: string } = {}, ctx: HookContext = {}): Promise<void> {
    if (!syncOnTurnEnd) return;
    const runId = text(event.runId) ?? text(ctx.runId);
    if (runId && finalized.delete(runId)) return;
    try {
      const result = await runSyns("sync", ctx, cwdFor(ctx));
      if (!result || result.code === 0) return;
      if (result.code !== RESOLUTION_REQUIRED) {
        host.warn(`syns sync: ${result.output}`);
        return;
      }
      if (pullOnTurnStart) {
        host.info("a resolution is pending; this runner cannot send the agent back, so the next turn's pull hands it over.");
        return;
      }
      const sessionKey = text(ctx.sessionKey);
      if (sessionKey && host.enqueueNextTurnInjection) {
        await host.enqueueNextTurnInjection({ sessionKey, text: pendingBeforeNewWork(result.output), placement: "prepend_context" });
        return;
      }
      host.warn(`syns sync: ${result.output}`);
    } catch (error) {
      host.warn(`sync hook error: ${errorText(error)}`);
    }
  }

  return { turnPrepare, beforeAgentFinalize, agentEnd };
}
