# claude-code-mods

This repository holds Claude Code mods, one per folder under `mods/`. It is a
plugin marketplace: `.claude-plugin/marketplace.json` lists each mod, and a
mod is installed from it with `/plugin install <name> --marketplace
zeapo/claude-code-mods`.

- Write a new mod directly in `mods/<name>/`, not in the session's
  `~/.claude/dev-mods/` folder: a mod left there loads in that session only.
- Load the `plugin-authoring` skill before writing or debugging a mod.
- After a change, run `claude plugin validate mods/<name>`,
  `claude plugin validate .` and `claude plugin test mods/<name>`.
- Raise `version` in the mod's `plugin.json` with a change that installed
  copies should receive.
- Add a row for a new mod to the table in `README.md`, and a section of its
  own.
- Give a new mod an entry in `.claude-plugin/marketplace.json` (`source`
  `./mods/<name>`, the `description` of its `plugin.json`).
