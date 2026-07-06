# Changelog

All notable changes to `syns-openclaw-plugins` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

First release. OpenClaw port of `syns-claude-plugins`. One plugin, two typed hooks.

### Added

- `syns` plugin: a Plugin SDK package (`definePluginEntry`) that registers two typed
  lifecycle hooks via `api.on(...)`:
  - `before_agent_run` → `syns pull --if-repo` at the start of every agent turn.
  - `agent_end` → `syns push --if-repo -m <msg>` at the end of every agent turn.
  Outside a Syns repo every invocation is a silent exit-0 no-op (`--if-repo`); inside a
  Syns repo every turn becomes one commit on the server.
- First-use bootstrap: if `syns` isn't on `PATH`, runs
  `curl -fsSL https://install.syns.dev/install.sh | sh` (cached to run at most once per
  process; toggle with `installIfMissing`).
- Plugin config via `openclaw.plugin.json` `configSchema` (`pushMessage`, `installIfMissing`,
  `pullOnTurnStart`, `pushOnTurnEnd`), read at hook time from `event.context.pluginConfig`.
  `pushMessage` falls back to `$SYNS_PUSH_MESSAGE`, then `openclaw session`.
- Per-cwd serialization mutex so a fire-and-forget `agent_end` push can't overlap the next
  turn's pull on persistent-gateway paths.
- `SYNS_CWD` env override: highest-priority working-directory source, so sync works
  deterministically regardless of how OpenClaw exposes the session working tree.
- Self-contained build: the SDK symbol (`definePluginEntry`) is declared ambiently, so
  `tsc` needs only `typescript` + `@types/node` — no dependency on the `openclaw` package.
  Built against `openclaw@2026.6.10`; compat floor `>=2026.5.4` (compiled-JS install baseline).
- Root npm workspace so `npm install && npm run build` from the repo root builds every plugin.
- Config options `cwd`, `synsBin`, and `debug` (settable via `openclaw config set
  plugins.entries.syns.config.*`): `cwd` is the highest-priority working-directory source and
  survives `gateway restart` (unlike `SYNS_CWD`); `synsBin` sets an absolute path when `syns`
  isn't on the daemon PATH; `debug` logs the resolved cwd and every syns invocation to stderr.

### OpenClaw-specific adaptations (vs. the Claude / Codex ports)

- **TypeScript SDK plugin, not shell hooks.** OpenClaw has no `hooks.json` command-string
  format; hooks are handlers registered with `api.on(...)` from a `definePluginEntry` entry.
- **Per-turn pull.** Mapped to `before_agent_run` (Claude/Codex pull only at `SessionStart`).
  By request, this port pulls on every turn.
- **Per-turn push.** Mapped to `agent_end` — the typed observation hook that fires when a
  turn completes. OpenClaw internal (shell) hooks have no agent-finalization event, so the
  Plugin SDK is required for the push trigger.
- **Conversation-access gating.** `before_agent_run`/`agent_end` are raw-conversation hooks;
  the operator must set `plugins.entries.syns.hooks.allowConversationAccess = true`.
- **Distribution via ClawHub / npm** (`openclaw plugins install`), not a plugin marketplace.

### Known limitations

- macOS and Linux only.
- First-run install activates from the next process (`install.sh` edits the shell rc, not the
  running process `PATH`).
- Working-directory resolution probes candidate context fields and falls back to the process
  cwd; the canonical OpenClaw field is unconfirmed (see `PLAN.md` § Open questions).
