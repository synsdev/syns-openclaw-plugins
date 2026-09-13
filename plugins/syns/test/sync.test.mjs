import assert from "node:assert/strict";
import test from "node:test";
import { createSyns } from "../dist/sync.js";

const ok = { code: 0, output: "" };
const missing = { code: 127, output: "not found" };

const INSTRUCTION = [
  "The repository alice/proj advanced while this working copy held local work. Your local work is preserved: nothing was published and nothing was discarded.",
  "",
  "Recovery id: rec-1",
  "Publish it with: syns resolution continue — continuing is what publishes; nothing is published until it runs.",
].join("\n");

const ctx = { runId: "run-1", sessionId: "sess-1", sessionKey: "agent:main:1", workspaceDir: "/work/repo" };

function harness({ config = {}, env = { HOME: "/home/alice" }, enqueue = true } = {}) {
  const calls = [];
  const infos = [];
  const warnings = [];
  const injections = [];
  const queue = [ok]; // the first run's `syns --help` probe
  const syns = createSyns(config, {
    env,
    home: () => "/home/alice",
    cwd: () => "/gateway",
    exec: async (command, args, options) => {
      calls.push({ command, args, ...options });
      return queue.shift() ?? ok;
    },
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    enqueueNextTurnInjection: enqueue
      ? async (injection) => { injections.push(injection); return { enqueued: true }; }
      : undefined,
  });
  return {
    syns,
    calls,
    infos,
    warnings,
    injections,
    answers: (...results) => { queue.push(...results); },
    runs: () => calls.filter((call) => call.args[0] === "pull" || call.args[0] === "sync"),
  };
}

const provenance = ({ env }) => [env.SYNS_INTEGRATION, env.SYNS_RUN, env.SYNS_TRIGGER];

// ---- silent successes -------------------------------------------------------

test("pulls before a turn with start provenance in the turn's workspace, adding nothing when it lands", async () => {
  const h = harness();
  h.answers({ code: 0, output: "Pulled alice/proj: 1 downloaded, 2 unchanged, 0 deleted" });
  assert.equal(await h.syns.turnPrepare({}, ctx), undefined);
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args]), [
    ["syns", ["--help"]],
    ["syns", ["pull", "--if-repo"]],
  ]);
  assert.equal(h.calls[1].cwd, "/work/repo");
  assert.deepEqual(provenance(h.calls[1]), ["openclaw", "sess-1", "start"]);
  assert.deepEqual([h.infos, h.warnings], [[], []]);
});

test("a configured cwd, then SYNS_CWD, outrank the turn's workspace", async () => {
  const h = harness({ config: { cwd: "/configured" }, env: { HOME: "/home/alice", SYNS_CWD: "/from-env" } });
  await h.syns.turnPrepare({}, ctx);
  assert.equal(h.runs()[0].cwd, "/configured");
  const e = harness({ env: { HOME: "/home/alice", SYNS_CWD: "/from-env" } });
  await e.syns.turnPrepare({}, ctx);
  assert.equal(e.runs()[0].cwd, "/from-env");
});

test("finalize syncs with finish provenance and lets the turn finish when it lands", async () => {
  const h = harness();
  h.answers({ code: 0, output: "Synced alice/proj: published 1a2b3c4d (version 2)" }, ok);
  assert.equal(await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx), undefined);
  assert.equal(await h.syns.beforeAgentFinalize({ runId: "run-2" }, ctx), undefined);
  assert.deepEqual(h.runs().map((call) => call.args), [["sync", "--if-repo"], ["sync", "--if-repo"]]);
  assert.deepEqual(provenance(h.runs()[0]), ["openclaw", "sess-1", "finish"]);
  assert.deepEqual([h.infos, h.warnings], [[], []]);
});

test("provenance set in the gateway's environment wins over the defaults", async () => {
  const h = harness({ env: { HOME: "/home/alice", SYNS_INTEGRATION: "my-gateway", SYNS_TRIGGER: "cron" } });
  await h.syns.turnPrepare({}, ctx);
  await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx);
  assert.deepEqual(h.runs().map(provenance), [["my-gateway", "sess-1", "cron"], ["my-gateway", "sess-1", "cron"]]);
});

test("agent_end does not sync again a turn before_agent_finalize already synced", async () => {
  const h = harness();
  await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx);
  await h.syns.agentEnd({ runId: "run-1" }, ctx);
  assert.equal(h.runs().length, 1);
});

test("agent_end syncs a turn no before_agent_finalize saw", async () => {
  const h = harness();
  await h.syns.agentEnd({ runId: "run-2" }, { ...ctx, runId: "run-2" });
  assert.deepEqual(h.runs().map((call) => call.args), [["sync", "--if-repo"]]);
});

test("turning syncing off, by either name, stops both finish hooks", async () => {
  for (const config of [{ syncOnTurnEnd: false }, { pushOnTurnEnd: false }]) {
    const h = harness({ config });
    assert.equal(await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx), undefined);
    await h.syns.agentEnd({ runId: "run-9" }, ctx);
    assert.equal(h.calls.length, 0);
  }
});

// ---- resolution required ----------------------------------------------------

test("resolution required at finalize sends the agent back with the CLI's output, every time", async () => {
  const h = harness();
  h.answers({ code: 4, output: INSTRUCTION }, { code: 4, output: INSTRUCTION });
  assert.deepEqual(await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx), { action: "revise", reason: INSTRUCTION });
  assert.deepEqual(await h.syns.beforeAgentFinalize({ runId: "run-1" }, ctx), { action: "revise", reason: INSTRUCTION });
  assert.deepEqual(h.warnings, []);
});

test("a resolution pending before a turn is prepended to that turn", async () => {
  const h = harness();
  h.answers({ code: 4, output: INSTRUCTION });
  assert.deepEqual(await h.syns.turnPrepare({}, ctx), {
    prependContext: `A Syns resolution is pending in this folder. Finish it before new work.\n\n${INSTRUCTION}`,
  });
});

test("a resolution at agent_end is left to the next turn's pull", async () => {
  const h = harness();
  h.answers({ code: 4, output: INSTRUCTION });
  await h.syns.agentEnd({ runId: "run-5" }, ctx);
  assert.deepEqual(h.injections, []);
  assert.match(h.infos.at(-1), /next turn's pull hands it over/);
});

test("with pulling before turns off, a resolution at agent_end is injected into the next turn", async () => {
  const h = harness({ config: { pullOnTurnStart: false } });
  h.answers({ code: 4, output: INSTRUCTION });
  await h.syns.agentEnd({ runId: "run-5" }, ctx);
  assert.deepEqual(h.injections, [{
    sessionKey: "agent:main:1",
    text: `A Syns resolution is pending in this folder. Finish it before new work.\n\n${INSTRUCTION}`,
    placement: "prepend_context",
  }]);
});

// ---- failures ---------------------------------------------------------------

test("each failure is logged with the CLI's own line and never sends the agent back", async () => {
  const lines = [
    { code: 1, output: "error: authentication required — run 'syns login' first" },
    { code: 3, output: "error: could not reach server at http://127.0.0.1:8099" },
    { code: 1, output: "error: server error (422): validation_error" },
    { code: 5, output: "error: attention required for alice/proj: the repository kept moving past every continuation round" },
  ];
  const h = harness();
  h.answers(...lines);
  for (let i = 0; i < lines.length; i++) assert.equal(await h.syns.beforeAgentFinalize({ runId: `run-${i}` }, ctx), undefined);
  assert.deepEqual(h.warnings, lines.map(({ output }) => `syns sync: ${output}`));
});

test("a failed pull is logged and adds nothing to the turn", async () => {
  const h = harness();
  h.answers({ code: 3, output: "error: could not reach server at http://x" });
  assert.equal(await h.syns.turnPrepare({}, ctx), undefined);
  assert.deepEqual(h.warnings, ["syns pull: error: could not reach server at http://x"]);
});

// ---- the CLI ------------------------------------------------------------------

test("installs the CLI once where it is missing and runs the installed binary", async () => {
  const calls = [];
  // five probes miss, the installer runs, `syns` still misses and ~/.cargo/bin/syns answers
  const results = [...Array(5).fill(missing), ok, missing, ok, ok];
  const syns = createSyns({}, {
    env: { HOME: "/home/alice" },
    home: () => "/home/alice",
    cwd: () => "/gateway",
    exec: async (command, args) => {
      calls.push([command, args]);
      return results.shift() ?? ok;
    },
    info: () => {},
    warn: () => {},
  });
  await syns.turnPrepare({}, ctx);
  assert.deepEqual(calls.slice(5), [
    ["sh", ["-c", "curl -fsSL https://install.syns.dev/install.sh | sh"]],
    ["syns", ["--help"]],
    ["/home/alice/.cargo/bin/syns", ["--help"]],
    ["/home/alice/.cargo/bin/syns", ["pull", "--if-repo"]],
  ]);
});
