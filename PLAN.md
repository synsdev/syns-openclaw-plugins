# Implementation plan — `syns-openclaw-plugins`

An [OpenClaw](https://docs.openclaw.ai) port of the `syns-claude-plugins` plugin. Goal: keep a
Syns working tree synced with the server while an agent works — adapted to OpenClaw's plugin
model. **By request, this port pulls AND pushes on every turn** (the Claude/Codex ports pull
only once at session start).

Sources: <https://docs.openclaw.ai/automation/hooks.md>,
<https://docs.openclaw.ai/plugins/building-plugins.md>, <https://docs.openclaw.ai/plugins/hooks.md>.

---

## 1. Reference behavior (the Claude Code plugin)

`syns-claude-plugins` is two shell-string hooks in `plugins/syns/hooks/hooks.json`:

| Event          | Command                                                            |
|:---------------|:------------------------------------------------------------------|
| `SessionStart` | install `syns` if missing, then `syns pull --if-repo`            |
| `Stop`         | `syns push --if-repo -m "${SYNS_PUSH_MESSAGE:-claude code session}"` |

Contract: silent no-op outside a Syns repo (`--if-repo`), hooks never block the agent, `Stop`
is per-turn (N turns → up to N commits), message from `$SYNS_PUSH_MESSAGE`.

CLI facts (CLI_IA.md, confirmed against the binary): `syns pull --if-repo` /
`syns push --if-repo -m <msg>`; `--if-repo` = "exit 0 silently unless `.syns.yaml` provided the
repository identity"; repo identity resolves from cwd (`--name` → `.syns.yaml` → git `origin`).

---

## 2. OpenClaw vs. Claude/Codex — the substance of the port

OpenClaw shares almost nothing with the Claude/Codex hook model. Three structural differences:

1. **Hooks are TypeScript, not shell strings.** There is no `hooks.json` command format. A
   plugin is an npm package with an entry built via `definePluginEntry`; it registers handlers
   with `api.on(name, handler, opts?)`. Handlers shell out to `syns` via `node:child_process`.

2. **Two hook surfaces; we need the typed one.** OpenClaw has *internal hooks* (`HOOK.md` +
   `handler.ts`, for Gateway/command events like `command:new`, `gateway:startup`,
   `message:sent`) and *typed plugin hooks* (`api.on`, for the agent lifecycle). **Internal
   hooks have no agent-finalization event** — the docs say `command:stop` is "cancellation,
   not an agent-finalization gate." The per-turn "agent finished" trigger exists *only* as a
   typed hook. So a faithful push-per-turn requires the Plugin SDK, not internal hooks.

3. **Distribution is ClawHub/npm**, installed via `openclaw plugins install clawhub:<pkg>` —
   not a marketplace of local plugin folders.

### Event mapping

| Claude Code     | Purpose      | OpenClaw typed hook        | Why |
|:----------------|:-------------|:---------------------------|:----|
| `SessionStart`  | `syns pull`  | **`before_agent_run`**     | Fires per turn, "after prompt construction, before model input" — refreshes the tree before the model runs tools. (We pull every turn by request, so a per-turn start hook is exactly right; no separate `session_start` needed.) |
| `Stop` (per turn) | `syns push` | **`agent_end`**           | Observation-only hook that fires once per completed turn — the clean analog of `Stop`. |

Considered and rejected:
- `command:stop` (internal) — only fires on explicit `/stop`, not per turn.
- `message:sent` (internal) — not documented as 1:1 per assistant turn; cadence unverified.
- `session_start` / `session_end` (typed) — conversation-scoped, not per-turn; wrong cadence
  for "every turn". (`session_end` with reason `shutdown`/`restart` could be a future
  final-push safety net.)
- `before_agent_finalize` (typed) — meant for "request another model pass", heavier contract
  than a fire-once side effect; `agent_end` is the right observation point.

---

## 3. Runtime decision: optimize for one-shot CLI

OpenClaw runs as a persistent Gateway or as a one-shot CLI. The two differ in how `agent_end`
is invoked:

- **One-shot CLI** — `agent_end` is **awaited**. Pull→work→push ordering is deterministic and
  the push completes before exit. **This is the target/supported semantics.**
- **Persistent Gateway** — `agent_end` runs **fire-and-forget**. The push still happens, but
  may be in flight when the turn returns. To keep correctness we add an **in-process per-cwd
  mutex** (`serialize()`), so a slow push from turn N can't interleave with the pull of turn
  N+1.

The plugin is runtime-agnostic; we just document one-shot as the clean path.

---

## 4. Repo layout

```
syns-openclaw-plugins/
  package.json              # root npm workspace (build all plugins from repo root)
  plugins/syns/
    package.json            # npm package + openclaw metadata (extensions, compat, build)
    openclaw.plugin.json    # plugin manifest (id, activation, configSchema)
    tsconfig.json           # ESM; src -> dist
    src/index.ts            # definePluginEntry + the two api.on hooks
    src/openclaw.d.ts       # ambient SDK decl (self-contained build)
    README.md
    LICENSE
  README.md
  CHANGELOG.md
  PLAN.md
  LICENSE
  .gitignore
```

A monorepo with `plugins/*`, each a standalone publishable package.

---

## 5. The plugin (`plugins/syns/src/index.ts`)

```ts
export default definePluginEntry({
  id: "syns", name: "Syns", description: "...",
  register(api) {
    api.on("before_agent_run", async (event) => {
      try { const cfg = resolveConfig(event); if (cfg.pullOnTurnStart) await pull(event, cfg); }
      catch (e) { console.error("[syns] pull hook error:", e); }
      return { outcome: "pass" };          // never block the turn
    }, { priority: 0, timeoutMs: 90_000 });

    api.on("agent_end", async (event) => {
      try { const cfg = resolveConfig(event); if (cfg.pushOnTurnEnd) await push(event, cfg); }
      catch (e) { console.error("[syns] push hook error:", e); }
    }, { priority: 0, timeoutMs: 60_000 });
  },
});
```

Supporting pieces (all in `src/index.ts`):
- **`resolveConfig(event)`** — reads `event.context.pluginConfig` (the resolved `configSchema`
  values); `pushMessage` falls back to `$SYNS_PUSH_MESSAGE` then `"openclaw session"`.
- **`resolveCwd(event)`** — probes candidate context fields for the session working tree
  (`context.workspaceDir`, `context.cwd`, `context.ctx.workspaceDir`,
  `context.config.workspace.dir`, `$OPENCLAW_WORKSPACE_DIR`) and falls back to `process.cwd()`.
  **Open question #1** — confirm the real field against a live gateway and tighten this.
- **`ensureSyns(cwd, installIfMissing)`** — `syns --version` check; if missing and enabled,
  runs the install script. Cached as a module-level promise so it runs at most once per process.
- **`serialize(cwd, fn)`** — per-cwd promise-chain mutex; a rejection in one link doesn't
  poison the next.
- **`runSyns(cwd, args)`** — `execFile("syns", args, { cwd, timeout })`; logs genuine failures
  to stderr, never throws (so `--if-repo`'s exit-0 no-op stays silent and real errors surface).

### Behavior contract (preserved from the Claude plugin)
- Outside a Syns repo → silent exit-0 no-op (`--if-repo`).
- Hooks never block/fail a turn: pull returns `{ outcome: "pass" }`; push is observation-only;
  both swallow errors after logging.
- Per turn → up to N pulls and N commits for N turns (empty turn pushes nothing).

---

## 6. `package.json` openclaw metadata

```jsonc
"openclaw": {
  "extensions": ["./dist/index.js"],
  "compat": { "pluginApi": ">=2026.3.24-beta.2", "minGatewayVersion": "2026.3.24-beta.2" },
  "build":  { "openclawVersion": "2026.3.24-beta.2", "pluginSdkVersion": "2026.3.24-beta.2" }
}
```
`type: module`, `engines.node >= 22.19`, entry points at **built JS** (`dist/index.js`) per the
docs. Built against `openclaw@2026.6.10` (current npm latest); compat floor `>=2026.5.4`, the
release where installed/linked plugins require compiled JS. The build does **not** depend on the
`openclaw` package — `definePluginEntry` is declared ambiently in `src/openclaw.d.ts`, so the
only build deps are `typescript` + `@types/node`; the gateway supplies the real SDK at runtime.

---

## 7. `openclaw.plugin.json` manifest

`id: "syns"`, `activation.onStartup: true` (the plugin must be live to register its hooks for
any session), and a `configSchema` with `pushMessage` / `installIfMissing` / `pullOnTurnStart`
/ `pushOnTurnEnd`. No `contracts.tools` — this plugin registers hooks, not agent tools.

---

## 8. Required operator config — conversation access

`before_agent_run` and `agent_end` are raw-conversation hooks; a non-bundled plugin must be
granted access or **the hooks silently never fire**:

```jsonc
{ "plugins": { "entries": { "syns": {
  "hooks": { "allowConversationAccess": true },
  "config": { "pushMessage": "openclaw session" }
}}}}
```

This is the OpenClaw analog of Codex's hook-trust step. It must be loud in the README.

---

## 9. Build, test, publish

```bash
cd plugins/syns
npm install            # or pnpm
npm run build          # tsc -> dist/
openclaw plugins inspect syns --runtime --json   # verify hooks register
clawhub package publish synsdev/syns --dry-run
clawhub package publish synsdev/syns
```
Install: `openclaw plugins install clawhub:synsdev/syns`.

---

## 10. Verification checklist (against a live OpenClaw)

1. **Outside a Syns repo:** run turns → no commits, no errors, no stray output.
2. **Inside a Syns repo:** each turn pulls at start and produces exactly one commit at end;
   empty turn → no commit.
3. **Never blocks:** force a pull failure (offline) at turn start → the turn still runs.
   Force a push failure → the turn still ends; error visible on stderr.
4. **Conversation access off:** confirm hooks don't fire (then document that this is the gate).
5. **cwd resolution:** confirm `syns` runs in the session working tree (validates
   `resolveCwd`); tighten the candidate list to the real field.
6. **Gateway overlap:** on a persistent gateway, confirm rapid turns don't interleave
   pull/push (validates `serialize`).
7. **First-run install:** on a host without `syns`, confirm install + "usable next process".

---

## 11. Open questions

1. **Working directory (highest priority).** Which `event.context` field carries the session
   working tree on conversation hooks? `resolveCwd()` probes candidates and falls back to
   `process.cwd()` — confirm and pin the real field. Everything (`--if-repo` resolution)
   depends on it. **Mitigated for testing:** the `SYNS_CWD` env var overrides all candidates,
   so the first test is deterministic; the `inspect --runtime --json` output should reveal the
   real field so we can tighten the probe list.
2. **`pluginConfig` shape at hook time.** Confirm `event.context.pluginConfig` carries the
   resolved `configSchema` values (vs. a nested or differently-named field).
3. **`before_agent_run` pass semantics.** Confirm returning `{ outcome: "pass" }` (or omitting)
   lets the turn proceed and that a thrown handler error can't fail the turn closed. Docs say
   only `pass`/`block` are supported and unsupported shapes "fail closed", so we always return
   `pass` and never throw — verify empirically.
4. **Version pins.** ✅ Resolved — built against `2026.6.10`, compat floor `>=2026.5.4`.
   Re-confirm against the gateway version actually installed on the test machine.
5. **Multi-workspace gateway.** If one gateway serves multiple workspaces/sessions, confirm the
   per-session cwd (open question #1) correctly isolates each repo; the per-cwd mutex already
   keys on it.

---

## 12. Open decisions for Bart

- **Repo name/location:** assumed `syns-openclaw-plugins` as a sibling under
  `github.com/synsdev/`. Confirm.
- **Per-turn pull:** implemented as requested (`before_agent_run`). Switch to once-per-session
  (`session_start`) if the per-turn pull proves too aggressive.
- **package name:** `@syns/openclaw-syns` / ClawHub spec `synsdev/syns` — confirm the org/scope.
- **Final-push safety net:** optionally also push on `session_end` (reason `shutdown`/`restart`)
  to capture state if the last turn's fire-and-forget push didn't finish. Not implemented yet.
