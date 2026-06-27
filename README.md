# syns-openclaw-plugins

[OpenClaw](https://docs.openclaw.ai) plugins for the [Syns](https://syns.dev) multi-agent
development platform.

This is the OpenClaw port of [`syns-claude-plugins`](https://github.com/synsdev/syns-claude-plugins) —
same goal (keep the working tree synced with the Syns server while an agent works), adapted
to OpenClaw's plugin model. OpenClaw has no shell-string `hooks.json`; plugins are TypeScript
npm packages that register **typed lifecycle hooks** through the Plugin SDK.

## What's in here

| Plugin                   | Description                                                                                              |
|:-------------------------|:-------------------------------------------------------------------------------------------------------|
| [`syns`](./plugins/syns) | Auto-pull on every turn start and auto-push on every turn end. One commit per agent turn. Silent no-op outside a Syns repo. |

## Install (local / development)

This repo isn't published yet, so install it from a local checkout. On the OpenClaw machine:

```bash
git clone https://github.com/synsdev/syns-openclaw-plugins.git
cd syns-openclaw-plugins
npm install            # installs typescript + @types/node (the only build deps)
npm run build          # compiles plugins/syns -> plugins/syns/dist/index.js

openclaw plugins install --link ./plugins/syns   # link-install (live, no copy)
openclaw plugins enable syns
openclaw gateway restart
openclaw plugins inspect syns --runtime --json   # confirm both hooks registered
```

Then grant the plugin conversation access (required for its hooks to fire) and, for a
deterministic first test, point it at your repo with `SYNS_CWD` — see the
[plugin README](./plugins/syns/README.md#required-configuration--conversation-access).

> Compiled JS is required: since OpenClaw 2026.5.4 the gateway won't load `.ts` for
> installed/linked plugins, so `npm run build` must run before `plugins install`. The build is
> self-contained (the SDK is provided by the gateway at runtime, declared ambiently for `tsc`).

Once published to ClawHub the install collapses to `openclaw plugins install clawhub:synsdev/syns`.

## How this port differs from the Claude / Codex ports

| | Claude Code / Codex | OpenClaw |
|:---|:---|:---|
| Hook body | shell command string in `hooks.json` | **TypeScript handler** (`api.on(...)`), shells out via `node:child_process` |
| Pull trigger | `SessionStart` (once per session) | `before_agent_run` (**every turn**) |
| Push trigger | `Stop` (per turn) | `agent_end` (per turn) |
| Distribution | plugin marketplace | **ClawHub** / npm (`openclaw plugins install`) |
| Gating | trust review | `plugins.entries.syns.hooks.allowConversationAccess` |

See [`PLAN.md`](./PLAN.md) for the full design, rationale, and open questions.

## Development

```bash
npm install          # from the repo root (workspaces)
npm run build        # build all plugins -> dist/
npm run check        # type-check only
```

The build deliberately does **not** depend on the `openclaw` package: the one SDK symbol used
(`definePluginEntry`) is declared ambiently in `plugins/syns/src/openclaw.d.ts`, and the
gateway supplies the real `openclaw/plugin-sdk/*` modules at runtime. Built against
`openclaw@2026.6.10`.

## License

MIT. See [LICENSE](./LICENSE).
