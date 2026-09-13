# `syns` plugin (OpenClaw)

Keeps a [Syns](https://syns.dev) working copy converged while an agent works, turn by turn.

| Hook (typed)            | Fires                     | Action                                                                                              |
|:------------------------|:--------------------------|:----------------------------------------------------------------------------------------------------|
| `agent_turn_prepare`    | before every turn         | `syns pull --if-repo`; a pending resolution is prepended to the turn.                                |
| `before_agent_finalize` | when a turn is about to finish | `syns sync --if-repo`; a resolution sends the agent back for another pass (`revise`).            |
| `agent_end`             | when a turn ended         | `syns sync --if-repo` for a turn no `before_agent_finalize` saw (a runner that never calls it).      |

Unlike the [Claude Code](https://github.com/synsdev/syns-claude-plugins) and
[Codex](https://github.com/synsdev/syns-codex-plugins) ports (which pull once at session
start), this port **pulls before every turn**.

The handlers run the commands a person would run and only map the CLI's exit code to OpenClaw:

| `syns` exits | before a turn | when a turn finishes |
|:--|:--|:--|
| `0`: synced, no changes, or not a Syns folder | nothing | nothing |
| `4`: resolution required | the CLI's instruction is prepended to the turn, asking the agent to finish it before new work | `before_agent_finalize` answers `revise` with the CLI's instruction. From `agent_end`, which can only observe, the next turn's pull hands it over. |
| anything else: a credential or permission failure, an unreachable server, a validation failure, attention required | a `[syns]` warning with the CLI's own line in the gateway log | the same; the agent is not continued |

Nothing publishes past a moved head until the agent runs `syns resolution continue`. OpenClaw caps `revise` at 3 passes per turn, and the CLI bounds its own rounds, ending with attention required.

---

## TL;DR — working setup

1. `plugins.entries.syns.hooks.allowConversationAccess = true`, or the finish hooks never fire.
2. The gateway process can find the `syns` binary. It is auto-detected, including `~/.cargo/bin`.
3. The gateway knows **which directory is your Syns repo**, through `config.cwd`, `SYNS_CWD` or the turn's workspace.
4. `syns login` has been run once as the user the gateway runs as.

```bash
# 1. build + install + enable
npm install && npm run build                 # from the repo root
openclaw plugins install --link ./plugins/syns
openclaw plugins enable syns

# 2. grant conversation access (required for before_agent_finalize and agent_end)
openclaw config set plugins.entries.syns.hooks.allowConversationAccess true

# 3. point syns at your repo (or let the turn's workspace name it)
openclaw config set plugins.entries.syns.config.cwd /path/to/your/syns/repo

openclaw plugins registry --refresh              # pick up the manifest
openclaw gateway restart                         # full restart, not just hot-reload
```

Verify a turn synced:

```bash
cd /path/to/your/syns/repo && syns status        # workingCopyState converged after each turn
```

---

## Install

Not published yet — install from a local checkout (build first; compiled JS is required since
OpenClaw 2026.5.4):

```bash
npm install && npm run build          # from the repo root
openclaw plugins install --link ./plugins/syns
openclaw plugins enable syns
openclaw plugins registry --refresh
openclaw gateway restart
openclaw plugins inspect syns
```

Once published: `openclaw plugins install clawhub:synsdev/syns`.

> **After editing the plugin's `openclaw.plugin.json` or rebuilding `dist/`, run
> `openclaw plugins registry --refresh` and do a full `openclaw gateway restart`.**
> A hot config reload (SIGUSR1) does **not** re-read a changed manifest or re-register
> hooks; a stale registry silently drops the plugin's hooks so nothing syncs.

---

## Required: conversation access

`before_agent_finalize` and `agent_end` are **conversation hooks**. A non-bundled plugin must be
explicitly granted conversation access or they never fire, and the gateway log shows
`typed hook "…" blocked because non-bundled plugins must set …allowConversationAccess=true`:

```jsonc
{
  "plugins": {
    "entries": {
      "syns": {
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

`agent_turn_prepare` is a prompt-injection hook. It runs unless you set `hooks.allowPromptInjection = false`, and that setting also stops a pending resolution from reaching the turn.

---

## Configuration

`plugins.entries.syns.config.*` is read when the plugin registers.

| Key                | Default  | Meaning                                                                                  |
|:-------------------|:---------|:-----------------------------------------------------------------------------------------|
| `installIfMissing` | `true`   | Install the `syns` CLI on first use if it is not found (at most once per process).       |
| `pullOnTurnStart`  | `true`   | Pull before every turn (`agent_turn_prepare`).                                           |
| `syncOnTurnEnd`    | `true`   | Sync when every turn finishes (`before_agent_finalize`, or `agent_end`).                 |
| `pushOnTurnEnd`    | —        | Deprecated: the earlier name of `syncOnTurnEnd`, read only where that is unset.          |
| `cwd`              | auto     | Repo dir. Outranks `SYNS_CWD`, which outranks the turn's workspace.                      |
| `synsBin`          | auto     | Path to `syns`. Normally unnecessary (auto-detected).                                    |

Environment variables on the **gateway service** (it does not inherit your interactive shell):

| Env var            | Purpose                                                                                  |
|:-------------------|:-----------------------------------------------------------------------------------------|
| `SYNS_CWD`         | Directory of your Syns repo (where `.syns.yaml` lives), where `config.cwd` is unset.     |
| `SYNS_INTEGRATION`, `SYNS_RUN`, `SYNS_TRIGGER`, `SYNS_TASK` | Published-by provenance. The plugin defaults the first three to `openclaw`, the session id and `start`/`finish`; any you set win. |

- **macOS (launchd):** append to `~/.openclaw/service-env/ai.openclaw.gateway.env` (merge; don't clobber the generated lines), then `openclaw gateway restart`.
- **Linux (systemd):** add `Environment=SYNS_CWD=/path/to/your/syns/repo` to the unit (or a drop-in), then `systemctl --user daemon-reload && openclaw gateway restart`.

The manifest schema uses `additionalProperties: true`, so an unrecognized config key such as the removed `pushMessage` never fails a config reload.

---

## Binary detection

The gateway daemon usually runs with a minimal `PATH` (launchd/systemd) that omits
`~/.cargo/bin`, so a bare `syns` isn't found. The plugin probes, in order:

```
syns  →  $HOME/.cargo/bin/syns  →  $HOME/.local/bin/syns  →  /usr/local/bin/syns  →  /opt/homebrew/bin/syns
```

`$HOME` is resolved from the environment and, if unset (bare launchd), from the OS user record.
Detection uses `syns --help` (exit 0), and the resolved path is cached per process. Set
`synsBin` (or symlink `syns` into a standard prefix) only for a non-standard install.

---

## Behavior contract

- **Outside Syns repos: silent no-op.** `--if-repo` exits 0 with no output.
- **A successful pull or sync logs nothing.**
- **Only a resolution continues the agent.** Every other failure is a `[syns]` warning with the CLI's own line, and the turn proceeds or ends normally.
- **Per turn.** Each turn pulls once and syncs once. A turn publishes what the folder holds at that moment, edits from other writers included, and a turn that changed nothing publishes nothing.
- **Serialized per working directory.** A slow sync from one turn never overlaps the next turn's pull.

---

## Troubleshooting

Watch the gateway log for `[syns]` lines.

| Symptom (in the gateway log)                                              | Cause / fix                                                                                     |
|:--------------------------------------------------------------------------|:------------------------------------------------------------------------------------------------|
| `typed hook … blocked because non-bundled plugins must set …`             | Set `plugins.entries.syns.hooks.allowConversationAccess = true`, then full restart.             |
| No `[syns]` lines at all; nothing syncs                                   | Stale plugin registry. `openclaw plugins registry --refresh` then **full** `gateway restart`.   |
| `the Syns CLI is not installed and could not be installed`               | Binary not on any probed path. Symlink `syns` into `/usr/local/bin`, or set `synsBin`.          |
| `syns sync: error: authentication required — run 'syns login' first`     | Run `syns login` as the user the gateway runs as.                                               |
| `syns sync: error: unrecognized subcommand 'sync'`                        | The CLI predates 0.3.0. Run `syns upgrade`.                                                     |
| Hook fires but syncs the wrong directory                                  | Set `config.cwd` or `SYNS_CWD` in the **service** env, then restart.                            |

---

## Runtime notes

- **Runners without `before_agent_finalize`** (the CLI-backend runner) sync in `agent_end`. That hook can only observe, so a resolution waits for the next turn, whose pull hands it to the agent. With `pullOnTurnStart` off, the plugin queues it as a next-turn injection instead.
- **First-run install activates next process** where `install.syns.dev/install.sh` put `syns` outside every probed path.
- **Requirements:** Syns CLI 0.3.0 or newer; OpenClaw 2026.7.1 or newer (verified against 2026.7.1-2); macOS and Linux.
