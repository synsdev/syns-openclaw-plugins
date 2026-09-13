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
| [`syns`](./plugins/syns) | Pulls before every agent turn and syncs when the turn finishes, continuing the agent only when a resolution is required. Silent no-op outside a Syns repo. |

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

Then grant the plugin conversation access (required for its finish hooks to fire), point it
at your repo with `config.cwd` or `SYNS_CWD`, and run `syns login` once — see the
[plugin README](./plugins/syns/README.md#required-configuration--conversation-access).

> Compiled JS is required: since OpenClaw 2026.5.4 the gateway won't load `.ts` for
> installed/linked plugins, so `npm run build` must run before `plugins install`. The build is
> self-contained (the SDK is provided by the gateway at runtime, declared ambiently for `tsc`).

Once published to ClawHub the install collapses to `openclaw plugins install clawhub:synsdev/syns`.

## How this port differs from the Claude / Codex ports

| | Claude Code / Codex | OpenClaw |
|:---|:---|:---|
| Hook body | shell command string in `hooks.json` | **TypeScript handler** (`api.on(...)`), shells out via `node:child_process` |
| Pull trigger | `SessionStart` (once per session) | `agent_turn_prepare` (**every turn**) |
| Sync trigger | `Stop` (per turn) | `before_agent_finalize` (per turn; `agent_end` where a runner never finalizes) |
| Distribution | plugin marketplace | **ClawHub** / npm (`openclaw plugins install`) |
| Gating | trust review | `plugins.entries.syns.hooks.allowConversationAccess` |

See [`PLAN.md`](./PLAN.md) for the full design, rationale, and open questions.

## Development

```bash
npm install          # from the repo root (workspaces)
npm run build        # build all plugins -> dist/
npm run check        # type-check only
npm test             # build, then run each plugin's tests
```

The build deliberately does **not** depend on the `openclaw` package: the one SDK symbol used
(`definePluginEntry`) is declared ambiently in `plugins/syns/src/openclaw.d.ts`, and the
gateway supplies the real `openclaw/plugin-sdk/*` modules at runtime. Built against
`openclaw@2026.6.10`.

## License

MIT. See [LICENSE](./LICENSE).
