# `syns` plugin (OpenClaw)

Two typed hooks. Per-turn sync.

| Hook (typed)       | Fires            | Action                                                                                          |
|:-------------------|:-----------------|:------------------------------------------------------------------------------------------------|
| `before_agent_run` | start of a turn  | `syns pull --if-repo` — refresh the working tree if it resolves to a Syns repo, no-op otherwise. |
| `agent_end`        | end of a turn    | `syns push --if-repo -m "<your message>"` — push the working tree as a single commit.            |

Unlike the [Claude Code](https://github.com/synsdev/syns-claude-plugins) and
[Codex](https://github.com/synsdev/syns-codex-plugins) ports (which pull once at session
start), this OpenClaw port **pulls and pushes on every turn**.

OpenClaw has no shell-string hook format; both hooks are TypeScript handlers registered
through the Plugin SDK (`definePluginEntry` + `api.on(...)`) that shell out to the `syns`
CLI via `node:child_process`.

## Install

Not published yet — install from a local checkout (build first; compiled JS is required since
OpenClaw 2026.5.4):

```bash
npm install && npm run build          # from the repo root
openclaw plugins install --link ./plugins/syns
openclaw plugins enable syns
openclaw gateway restart
openclaw plugins inspect syns --runtime --json
```

Once published: `openclaw plugins install clawhub:synsdev/syns`. See the
[repo README](../../README.md) for the full flow.

## Required configuration — conversation access

`before_agent_run` and `agent_end` are **raw-conversation hooks**. A non-bundled plugin must
be explicitly granted conversation access or the hooks never fire:

```jsonc
{
  "plugins": {
    "entries": {
      "syns": {
        "hooks": { "allowConversationAccess": true },
        "config": {
          "pushMessage": "openclaw session",
          "installIfMissing": true,
          "pullOnTurnStart": true,
          "pushOnTurnEnd": true
        }
      }
    }
  }
}
```

### Config options (all optional)

| Key                | Default            | Meaning                                                              |
|:-------------------|:-------------------|:--------------------------------------------------------------------|
| `pushMessage`      | `openclaw session` | Commit message for `syns push`. Overrides `$SYNS_PUSH_MESSAGE`.      |
| `installIfMissing` | `true`             | Install the `syns` CLI on first use if it's not on `PATH`.           |
| `pullOnTurnStart`  | `true`             | Pull at the start of every turn (`before_agent_run`).               |
| `pushOnTurnEnd`    | `true`             | Push at the end of every turn (`agent_end`).                        |

If `pushMessage` is unset, the plugin falls back to the `SYNS_PUSH_MESSAGE` env var, then to
`openclaw session`.

## Behavior contract

- **Outside Syns repos: silent no-op.** The `--if-repo` flag exits 0 with no output unless a
  `.syns.yaml` resolves the repository identity.
- **Hooks never block or fail a turn.** Pull runs in `before_agent_run` and always returns a
  `pass` outcome; push runs in observation-only `agent_end`. Pull/push errors (network, auth,
  server) are logged to stderr and swallowed — the turn proceeds/ends normally.
- **Per turn.** A conversation with N model turns produces up to N pulls and N commits (a turn
  that changes nothing pushes nothing).
- **Ordering is serialized per working directory.** On persistent-gateway paths `agent_end`
  runs fire-and-forget; an in-process per-cwd mutex prevents a slow push from turn N from
  overlapping the pull of turn N+1.

## Working directory

`syns` runs with its cwd set to the session's working tree (where `.syns.yaml` lives). OpenClaw
doesn't document one canonical context field for this, so `resolveCwd()` probes candidates and
falls back to the process cwd. For a **deterministic first test**, set `SYNS_CWD` to your repo
path — it overrides everything:

```bash
SYNS_CWD=/path/to/your/syns/repo openclaw gateway restart
```

(Or simply launch OpenClaw from inside the repo so `process.cwd()` is already correct.)

## Runtime notes

- **Best fit: one-shot CLI runs**, where `agent_end` is awaited so each turn's push completes
  before exit. On a persistent gateway `agent_end` is fire-and-forget; the per-cwd mutex keeps
  pulls/pushes from interleaving, but a push may still be in flight when the turn returns.
- **First-run install activates next process.** `install.syns.dev/install.sh` edits the shell
  rc, not the running process `PATH`, so a freshly installed `syns` may not be visible until
  the next OpenClaw process — the first run's sync silently no-ops.
- **macOS and Linux only**, matching the other Syns ports.

## Known open questions

See [`PLAN.md`](../../PLAN.md) § "Open questions". The most important is **which context field
gives the per-session working directory** — `resolveCwd()` in `src/index.ts` probes the known
candidates and falls back to `process.cwd()`; confirm and tighten it against a live gateway.
