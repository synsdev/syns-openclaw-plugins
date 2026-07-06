# `syns` plugin (OpenClaw)

Two typed hooks. Per-turn sync of a [Syns](https://syns.dev) repository.

| Hook (typed)       | Fires            | Action                                                                                           |
|:-------------------|:-----------------|:-------------------------------------------------------------------------------------------------|
| `before_agent_run` | start of a turn  | `syns pull --if-repo` — refresh the working tree if it resolves to a Syns repo, no-op otherwise. |
| `agent_end`        | end of a turn    | `syns push --if-repo -m "<message>"` — commit + push the working tree as a single version.       |

Unlike the [Claude Code](https://github.com/synsdev/syns-claude-plugins) and
[Codex](https://github.com/synsdev/syns-codex-plugins) ports (which pull once at session
start), this OpenClaw port **pulls and pushes on every turn**.

OpenClaw has no shell-string hook format; both hooks are TypeScript handlers registered
through the Plugin SDK (`definePluginEntry` + `api.on(...)`) that shell out to the `syns`
CLI via `node:child_process`.

---

## TL;DR — working setup

Three things must be true for the plugin to actually sync (all covered below):

1. `plugins.entries.syns.hooks.allowConversationAccess = true` — or the hooks never fire.
2. The gateway process can find the `syns` binary — auto-detected, incl. `~/.cargo/bin`.
3. The gateway knows **which directory is your Syns repo** — set the `SYNS_CWD` env var.

```bash
# 1. build + install + enable
npm install && npm run build                 # from the repo root
openclaw plugins install --link ./plugins/syns
openclaw plugins enable syns

# 2. grant conversation access (required)
openclaw config set plugins.entries.syns.hooks.allowConversationAccess true

# 3. point syns at your repo via the service env (reliable knob — see "Configuration")
#    Add: export SYNS_CWD='/path/to/your/syns/repo'   to the gateway service env file,
#    then restart. (Details + why below.)

openclaw plugins registry --refresh              # pick up the manifest
openclaw gateway restart                         # full restart, not just hot-reload
```

Verify a turn actually pushed:

```bash
cd /path/to/your/syns/repo && syns status        # Commit + Updated should advance each turn
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

`before_agent_run` and `agent_end` are **raw-conversation hooks**. A non-bundled plugin must be
explicitly granted conversation access or the hooks never fire (you'll see
`typed hook "…" blocked because non-bundled plugins must set …allowConversationAccess=true` in
the gateway log):

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

---

## Configuration

### Use environment variables, not just `config` (important)

On the **persistent gateway path**, `event.context.pluginConfig` is not reliably populated for
these hooks — it frequently arrives as `null`. That means values under
`plugins.entries.syns.config.*` (`cwd`, `synsBin`, …) may **not reach the running hook**. Do
not rely on them for anything load-bearing.

The reliable knobs are **environment variables** on the gateway service env, plus the plugin's
built-in auto-detection:

| Env var             | Purpose                                                        | Required?                              |
|:--------------------|:---------------------------------------------------------------|:---------------------------------------|
| `SYNS_CWD`          | Directory of your Syns repo (where `.syns.yaml` lives).        | **Yes**, unless the gateway's own cwd is already inside the repo. |
| `SYNS_PUSH_MESSAGE` | Commit message for `syns push`.                                | No (default `openclaw session`).       |

#### Setting env vars for a service-managed gateway (macOS launchd / Linux systemd)

The gateway daemon does **not** inherit your interactive shell env. Set the vars in the service
environment:

- **macOS (launchd):** OpenClaw generates an env file at
  `~/.openclaw/service-env/ai.openclaw.gateway.env`. Append your vars (merge — don't clobber the
  generated lines), then restart:

  ```bash
  echo "export SYNS_CWD='/path/to/your/syns/repo'" >> ~/.openclaw/service-env/ai.openclaw.gateway.env
  openclaw gateway restart
  ```

- **Linux (systemd):** add `Environment=SYNS_CWD=/path/to/your/syns/repo` to the unit (or a
  drop-in), then `systemctl --user daemon-reload && openclaw gateway restart`.

For a quick **one-shot / foreground** test you can just export inline:

```bash
SYNS_CWD=/path/to/your/syns/repo openclaw gateway restart
```

### `config` options (advisory — subject to the caveat above)

| Key                | Default            | Meaning                                                        |
|:-------------------|:-------------------|:---------------------------------------------------------------|
| `pushMessage`      | `openclaw session` | Commit message. Overrides `$SYNS_PUSH_MESSAGE` **if injected**. |
| `installIfMissing` | `true`             | Install the `syns` CLI on first use if it's not found.         |
| `pullOnTurnStart`  | `true`             | Pull at the start of every turn (`before_agent_run`).          |
| `pushOnTurnEnd`    | `true`             | Push at the end of every turn (`agent_end`).                   |
| `cwd`              | auto               | Repo dir. Prefer `SYNS_CWD` — this may not reach the hook.      |
| `synsBin`          | auto               | Path to `syns`. Normally unnecessary (auto-detected).          |

The manifest schema uses `additionalProperties: true`, so an unrecognized config key never
fails config reload (a stricter schema previously caused reloads to be skipped, which reverted
the plugin to defaults).

---

## Binary detection

The gateway daemon usually runs with a minimal `PATH` (launchd/systemd) that omits
`~/.cargo/bin`, so a bare `syns` isn't found. The plugin probes, in order:

```
syns  →  $HOME/.cargo/bin/syns  →  $HOME/.local/bin/syns  →  /usr/local/bin/syns  →  /opt/homebrew/bin/syns
```

`$HOME` is resolved from the environment and, if unset (bare launchd), from the OS user record
(`os.userInfo()` / `os.homedir()`), so `~/.cargo/bin/syns` resolves even when the daemon has no
`HOME`. Detection uses `syns --help` (exit 0) — **not** `syns --version`, which the
subcommand-only CLI rejects. The resolved path is cached per process. Set `synsBin` (or just
symlink `syns` into a standard prefix) only for a non-standard install.

---

## Behavior contract

- **Outside Syns repos: silent no-op.** `--if-repo` exits 0 with no output unless a `.syns.yaml`
  resolves the repository identity.
- **Hooks never block or fail a turn.** Pull runs in `before_agent_run` and always returns a
  `pass` outcome; push runs in observation-only `agent_end`. Pull/push errors (network, auth,
  server) are logged to stderr and swallowed — the turn proceeds/ends normally.
- **Per turn.** A conversation with N model turns produces up to N pulls and N commits (a turn
  that changes nothing pushes nothing).
- **Ordering is serialized per working directory.** On persistent-gateway paths `agent_end`
  runs fire-and-forget; an in-process per-cwd mutex prevents a slow push from turn N from
  overlapping the pull of turn N+1.

---

## Troubleshooting

Watch the gateway log for `[syns]` lines (only genuine failures are logged; successful
pulls/pushes and no-ops are silent).

| Symptom (in the gateway log)                                              | Cause / fix                                                                                     |
|:--------------------------------------------------------------------------|:------------------------------------------------------------------------------------------------|
| `typed hook … blocked because non-bundled plugins must set …`             | Set `plugins.entries.syns.hooks.allowConversationAccess = true`, then full restart.             |
| No `[syns]` lines at all; nothing syncs                                   | Stale plugin registry. `openclaw plugins registry --refresh` then **full** `gateway restart`.   |
| `syns CLI not found after install …`                                      | Binary not on any probed path. Symlink `syns` into `/usr/local/bin`, or set `synsBin`.          |
| Hook fires but pull/push runs in the wrong dir (no commit)                | `cwd` isn't the repo. Set `SYNS_CWD` in the **service** env (not just your shell), then restart. |
| `config reload skipped (invalid config): … additional properties`        | Old strict schema cached. Rebuild, `registry --refresh`, full restart (fixed in current build). |
| `syns … failed: …` (network/auth/server)                                  | A genuine `syns` error — run the same command manually from the repo to see the full message.   |

Quick manual sanity check (bypasses OpenClaw entirely):

```bash
cd /path/to/your/syns/repo
syns push --if-repo -m "manual test"
syns status
```

---

## Runtime notes

- **Best fit: one-shot CLI runs**, where `agent_end` is awaited so each turn's push completes
  before exit. On a persistent gateway `agent_end` is fire-and-forget; the per-cwd mutex keeps
  pulls/pushes from interleaving, but a push may still be in flight when the turn returns.
- **First-run install activates next process.** `install.syns.dev/install.sh` edits the shell
  rc, not the running process `PATH`, so a freshly installed `syns` may not be visible until the
  next OpenClaw process — that first run's sync silently no-ops.
- **macOS and Linux only**, matching the other Syns ports.
