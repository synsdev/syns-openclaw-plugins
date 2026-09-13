# Changelog

All notable changes to `syns-openclaw-plugins` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-13

### Changed

- The `syns` plugin runs `syns sync --if-repo` when a turn finishes instead of `syns push`. It brings in the repository head and publishes the whole folder; where the head moved, it prepares a resolution instead of refusing.
- Hooks moved to where OpenClaw lets a plugin act on the result:
  - `agent_turn_prepare` pulls and prepends a pending resolution to the turn.
  - `before_agent_finalize` syncs and answers `revise` with the CLI's instruction when a resolution is required.
  - `agent_end` syncs a turn no `before_agent_finalize` saw.
  - `before_agent_run` is no longer used: it could not add context, and a slow or failed pull there blocked the person's message.
- The handlers only map the CLI's exit code:
  - Exit 0 is silent.
  - Exit 4 continues the agent with the CLI's own output.
  - Anything else is a `[syns]` warning with the CLI's own line.
- Every publication carries published-by provenance: `SYNS_INTEGRATION=openclaw`, `SYNS_RUN` (the session id) and `SYNS_TRIGGER` (`start` or `finish`). Each is a default only: a value set in the gateway environment wins.
- Configuration is read from `api.pluginConfig` at registration and the working directory from the hook context's `workspaceDir`. The earlier `event.context` lookups never received either.
- New `syncOnTurnEnd` config key; `pushOnTurnEnd` is kept as a deprecated alias.
- Compatibility floor raised to OpenClaw 2026.7.1, verified against 2026.7.1-2.
- Tests (`npm test`) and a CI workflow.

### Removed

- `pushMessage` config and `SYNS_PUSH_MESSAGE`: `syns sync` takes no commit message.

### Requires

- Syns CLI 0.3.0 or newer.

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
- Environment variables are the reliable configuration knobs: `SYNS_CWD` sets the repo working
  directory (highest-priority cwd source) and `SYNS_PUSH_MESSAGE` sets the commit message
  (default `openclaw session`). On the persistent-gateway hook path `event.context.pluginConfig`
  is frequently `null`, so these env vars — not `config` — are what reliably reach the hook.
- Plugin config via `openclaw.plugin.json` `configSchema` (`pushMessage`, `installIfMissing`,
  `pullOnTurnStart`, `pushOnTurnEnd`, `cwd`, `synsBin`), read from `event.context.pluginConfig`
  when present (advisory — see env-var note above). The schema uses `additionalProperties: true`
  so an unrecognized key never causes a config-reload skip.
- Per-cwd serialization mutex so a fire-and-forget `agent_end` push can't overlap the next
  turn's pull on persistent-gateway paths.
- Binary auto-detection: probes the daemon PATH plus common install locations (`~/.cargo/bin`,
  `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) so cargo/curl installs are found under
  a minimal launchd/systemd PATH. `$HOME` falls back to the OS user record (`os.userInfo()` /
  `os.homedir()`) for bare daemon environments, and detection uses `syns --help` (not
  `--version`, which the subcommand-only CLI rejects). `synsBin` overrides for non-standard installs.
- Self-contained build: the SDK symbol (`definePluginEntry`) is declared ambiently, so
  `tsc` needs only `typescript` + `@types/node` — no dependency on the `openclaw` package.
  Built against `openclaw@2026.6.10`; compat floor `>=2026.5.4` (compiled-JS install baseline).
- Root npm workspace so `npm install && npm run build` from the repo root builds every plugin.

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
- Working-directory resolution: `pluginConfig` is often `null` on the gateway hook path and
  OpenClaw exposes no canonical workspace field for conversation hooks, so `SYNS_CWD` must be set
  in the gateway **service** env (see README § Configuration). Otherwise it probes context fields
  and falls back to the process cwd.
- After editing the manifest or rebuilding `dist/`, a full `gateway restart` (plus
  `openclaw plugins registry --refresh`) is required — a hot config reload won't re-register hooks.
