# claude-mods

Personal mods for Claude Code. Each folder under `mods/` is one mod, loaded in
every session once the folder is declared.

## Install

```sh
./install.sh
```

This adds `mods/` to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`
(the previous file is kept as `settings.json.bak`). Run it once per machine,
then start a new session. `./install.sh --uninstall` removes the declaration.

Requires `jq`.

## Mods

| Mod | What it does |
| --- | --- |
| [`effort-router`](mods/effort-router) | Classifies each message as discussion or implementation, sets the main model's effort (and optionally its model) to match, and routes implementation to an implementer agent. `/route auto\|chat\|impl` shows or pins the mode. |

### effort-router options

Each option is a row in `/config`; a change reloads the mod. They are stored in
`~/.claude/settings.json` under `pluginConfigs["effort-router"].options`.

| Option | Default | Meaning |
| --- | --- | --- |
| `chat_effort` | `low` | Effort of the main loop on a discussion message |
| `impl_effort` | `high` | Effort of the main loop on an implementation message |
| `chat_model` | empty | Model of the main loop in chat; empty keeps the session's |
| `impl_model` | empty | Model of the main loop in impl; empty keeps the session's |
| `routed_model` | `fable` | Only a session whose model id contains this is routed; empty routes all |
| `classifier_model` | `haiku` | Model that decides chat or impl |
| `classifier_timeout_ms` | `2500` | Classifier time limit; past it the mode in force is kept |
| `delegate` | `true` | Hand implementation to the implementer agent; off changes effort and model only |
| `implementer_model` | `opus` | Model of the implementer agent |
| `implementer_effort` | `high` | Default effort of the implementer agent |

Efforts are `low`, `medium`, `high`, `xhigh` or `max`; models are an alias
(`haiku`, `sonnet`, `opus`) or a full id. A main-loop model that changes
between messages loses the prompt cache.

## Adding a mod

Create `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and
the hooks module. No new `install.sh` run is needed: a new session loads it,
and an interactive session reloads a mod when its files change.

```sh
claude plugin validate mods/<name>   # what the engine will accept or refuse
claude plugin test mods/<name>       # the mod's *.test.ts
```

`.claude-plugin/types/` inside a mod is written by Claude Code and ignored by
git.
