# claude-mods

This repository holds the user's Claude Code mods, one per folder under
`mods/`. That folder is declared in `env.CLAUDE_CODE_PLUGIN_DIRS` of the user
settings by `install.sh`, so every session loads each mod in it.

- Write a new mod directly in `mods/<name>/`, not in the session's
  `~/.claude/dev-mods/` folder: a mod left there loads in that session only.
- Load the `plugin-authoring` skill before writing or debugging a mod.
- After a change, run `claude plugin validate mods/<name>` and
  `claude plugin test mods/<name>`.
- Add a row for a new mod to the table in `README.md`.
- Give a new mod an entry in `.claude-plugin/marketplace.json` (`source`
  `./mods/<name>`, the `description` of its `plugin.json`).
