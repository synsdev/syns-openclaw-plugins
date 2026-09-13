/**
 * Syns plugin for OpenClaw.
 *
 * Keeps a Syns working copy converged while an agent works:
 *   - agent_turn_prepare     ->  `syns pull --if-repo`, prepending a pending resolution to the turn
 *   - before_agent_finalize  ->  `syns sync --if-repo`, sending the agent back only when a
 *                                resolution is required
 *   - agent_end              ->  `syns sync --if-repo` for a turn no before_agent_finalize saw
 *                                (runners that never call it); it can only observe
 *
 * The plugin holds no reconciliation policy; see ./sync.ts. Every publication carries
 * published-by provenance: SYNS_INTEGRATION=openclaw, SYNS_RUN (the session), SYNS_TRIGGER.
 *
 * Requirements:
 *   - Node 22.19+ (OpenClaw runtime).
 *   - before_agent_finalize and agent_end are conversation hooks, so a non-bundled plugin
 *     must be granted conversation access in the gateway config:
 *       plugins.entries.syns.hooks.allowConversationAccess = true
 *     Without it only the pull before each turn runs. See README.
 *
 * Configuration: `plugins.entries.syns.config.*` arrives as `api.pluginConfig` at
 * registration; SYNS_CWD in the gateway service env names the repository directory where
 * the turn's workspace is not it.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSyns, execCommand, resolveHome, type NextTurnInjection, type SynsConfig } from "./sync.js";

const LOG_PREFIX = "[syns]";

export default definePluginEntry({
  id: "syns",
  name: "Syns",
  description:
    "Pulls a Syns repository before every agent turn and syncs it when the turn finishes, scoped to directories containing a .syns.yaml.",
  register(api: any) {
    const logger = api.logger;
    const workflow = api.session?.workflow;
    const enqueue = workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;
    const log = (level: "info" | "warn", message: string) => {
      if (typeof logger?.[level] === "function") logger[level](`${LOG_PREFIX} ${message}`);
      else console.error(`${LOG_PREFIX} ${message}`);
    };

    const syns = createSyns((api.pluginConfig ?? {}) as SynsConfig, {
      env: process.env,
      exec: execCommand,
      home: resolveHome,
      cwd: () => process.cwd(),
      info: (message) => log("info", message),
      warn: (message) => log("warn", message),
      enqueueNextTurnInjection: typeof enqueue === "function"
        ? (injection: NextTurnInjection) => enqueue.call(workflow ?? api, injection)
        : undefined,
    });

    api.on("agent_turn_prepare", syns.turnPrepare, { priority: 0 });
    api.on("before_agent_finalize", syns.beforeAgentFinalize, { priority: 0, timeoutMs: 300_000 });
    api.on("agent_end", syns.agentEnd, { priority: 0, timeoutMs: 300_000 });
  },
});
