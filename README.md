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
| [`effort-router`](mods/effort-router) | Classifies each message as discussion or implementation, sets the main model's effort to match, and routes implementation to an Opus implementer agent. `/route auto\|chat\|impl` shows or pins the mode. |

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
