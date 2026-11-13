# claude-code-mods

Mods for Claude Code. A mod is a plugin with a hooks module: it changes how
Claude Code behaves or what it shows. Each folder under `mods/` is one mod,
and this repository is a plugin marketplace listing each of them.

## Install

Each mod is installed on its own, by its name. Type this at the prompt of a
Claude Code session:

```
/plugin install effort-router --marketplace zeapo/claude-code-mods
```

Claude Code asks to add the `zeapo/claude-code-mods` marketplace, then for a
scope (where the mod is enabled). Then start a new session. Any mod listed
under [Mods](#mods) installs the same way, with its own name in place of
`effort-router`.

### Working on the mods from a clone

To edit the mods and run them from a clone of this repository instead:

```sh
./install.sh
```

This adds `mods/` to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`
(the previous file is kept as `settings.json.bak`), so every new session loads
each mod from the clone, and an interactive session reloads a mod when its
files change. Run it once per machine, then start a new session.
`./install.sh --uninstall` removes the declaration. Requires `jq`.

Use one route or the other for a given mod, not both at once: uninstall a mod
installed from the marketplace (`claude plugin uninstall effort-router`)
before running `./install.sh`, and run `./install.sh --uninstall` before
installing from the marketplace.

## Mods

| Mod | What it does |
| --- | --- |
| [`effort-router`](#effort-router) | Runs the main loop at low effort on discussion, at xhigh effort on design and at high effort on implementation, which it hands to an implementer agent. |

## effort-router

For each message you send, effort-router decides whether it is discussion
(`chat`), design work done before any code is changed (`design`: brainstorming
an approach, weighing trade-offs, writing or reviewing a plan or spec) or
implementation (`impl`), and sets the effort of the main loop to match: low for
discussion, xhigh for design, high for implementation. The main loop keeps one
model throughout; only its effort changes. On implementation it also asks the
main model to plan, hand the code changes to an implementer agent running on a
second model, and review the result. The code is in
[`mods/effort-router`](mods/effort-router).

<p align="center"><img src="mods/effort-router/assets/router.svg" alt="Railway diagram of effort-router. A message either takes a bypass (a pinned mode, or a bare approval while in impl) or stops at the classifier, which sets a switch to one of three lines: the chat line, where the main loop runs at low effort, the design line, where it runs at xhigh effort, or the impl line, where it runs at high effort and hands the change to an implementer agent on a siding. An unsure answer, a timeout or a failure leaves the switch where it was. A board at the bottom shows the band above the prompt." width="100%"></p>

### How it works

1. A slash command, a notification or an empty prompt is passed through as is,
   and the mode stays as it was.
2. If the mode is pinned with `/route chat`, `/route design` or `/route impl`,
   the pin decides, with no model call.
3. If the mode is `impl` and the message is a bare approval (`ok`, `vas-y`,
   `go ahead` and the like), it stays `impl`, with no model call.
4. Otherwise a classifier (`haiku` at low effort) reads the message, the end of
   the assistant's last answer and the current mode, and replies with one of
   the three modes and its confidence, such as `chat 0.92`, usually within a
   few seconds. A request to plan or design a change without asking for it to
   be made is `design`; a factual question is `chat`, even on a technical
   topic. At a confidence of 0.6 or more the mode becomes its answer. Below
   that, after a 6 second timeout, or on a failure, the mode in force is kept.
   A new session starts in `impl`.
5. The mode sets the effort of every request of the main loop: `chat` runs at
   low effort, `design` at xhigh effort, `impl` at high effort. Its model is
   never changed. Only the main loop of a session whose model id contains
   `main_model` is routed. Subagents keep their own model and effort, and so
   does an effort you raised past high (`/effort xhigh`, ultrathink); a
   session at high runs at xhigh in `design`.
6. Only in `impl`, with `delegate` on, the message gets a note telling the main
   model to act as orchestrator: settle a plan, hand the code changes to the
   `effort-router:implementer` agent (on `sub_model` at `impl_sub_effort`,
   opus at high effort by default, unless the call names another effort), then
   review the diff and run the checks. A change of a few lines it has already
   located it may make itself.

### Commands

`/route` shows the mode, the classifier's timings and outcomes, how the last
message was routed, what the main loop's last request went out with, and the
settings. `/route chat`, `/route design` or `/route impl` pins the mode;
`/route auto` goes back to choosing it per message.

A mod's commands exist once the session has started, so in the desktop app
`/route` is available after the first message of a session.

### What it shows

A row in the band above the prompt shows the mode, the model and effort the
main loop's last request in that mode went out with, and how the last message
was routed. Before that first request it shows the effort the mode asks for.
An effort you raised past high shows as it went out.

```
● chat · fable-5-2 · low · classifier: chat 0.92 in 1840 ms
● design · fable-5-2 · xhigh · classifier: design 0.88 in 1510 ms
● impl · fable-5-2 · high · classifier unsure: chat 0.55 < 0.6, kept impl
● impl · fable-5-2 · high · classifier timed out (6000 ms), kept impl
○ not routed · opus-5-5 · only models matching "fable"
```

The first two messages were decided by the classifier. The third got an answer
below the minimum confidence and the fourth no answer in time: both kept the
mode in force, and that part of the row shows in the warning colour. A pinned
mode shows `(pinned)` after the effort.

The last row is a session whose model does not contain `main_model`: its
messages go through untouched, with no classifier call and no note, and the
row follows a switch of model with `/model`.

### Options

Each option is a row in `/config`; a change reloads the mod. They are stored in
`~/.claude/settings.json` under `pluginConfigs["effort-router"].options`.

Two models, and an effort for each mode they run in. With the defaults:

| | `chat` | `design` | `impl` |
| --- | --- | --- | --- |
| Main loop (`main_model`, `fable`) | low | xhigh | high |
| Implementer (`sub_model`, `opus`) | | | high |

| Option | Default | Meaning |
| --- | --- | --- |
| `main_model` | `fable` | Model of the main loop. Only a session whose model id contains this text is routed, and the mod never changes its model; empty routes a session on any model |
| `sub_model` | `opus` | Model of the implementer agent, which does the code changes in impl: an alias or a full id. Other subagents keep their own models |
| `chat_main_effort` | `low` | Effort of the main loop on a discussion message |
| `design_main_effort` | `xhigh` | Effort of the main loop on a design message |
| `impl_main_effort` | `high` | Effort of the main loop on an implementation message |
| `impl_sub_effort` | `high` | Default effort of the implementer agent; the main model may pass another on a call |
| `classifier_model` | `haiku` | Model that decides chat, design or impl for each message: an alias or a full id |
| `classifier_timeout_ms` | `6000` | How long the classifier may take before the mode in force is kept |
| `classifier_min_confidence` | `0.6` | Confidence from 0 to 1 the classifier must give its answer for the mode to change. An answer below it keeps the mode in force; 0 accepts every answer |
| `delegate` | `true` | On an implementation message, tell the main model to hand the code changes to the implementer agent. Off: only the effort changes |

Efforts are `low`, `medium`, `high`, `xhigh` or `max`; models are an alias
(`haiku`, `sonnet`, `opus`) or a full id. The main loop's model is never
changed, so its prompt cache is kept across modes as far as the model takes
effort per message. The sub model runs the implementer and nothing else: other
subagents (Explore, general-purpose, a reviewer) keep their own model and
effort.

## Adding a mod

Create `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and
the hooks module. No new `install.sh` run is needed: a new session loads it,
and an interactive session reloads a mod when its files change.

```sh
claude plugin validate mods/<name>   # what the engine will accept or refuse
claude plugin test mods/<name>       # the mod's *.test.ts
```

Then give the mod its line in the index under [Mods](#mods) and a section of
its own with the same sub-headings as the others (How it works, Commands, What
it shows, Options), leaving out any that do not apply. A diagram goes in the
mod's `assets/` folder. A new mod also gets an entry in
`.claude-plugin/marketplace.json`, with its `name`, its `source`
(`./mods/<name>`) and the `description` of its `plugin.json`, so it can be
installed from the marketplace.

`.claude-plugin/types/` inside a mod is written by Claude Code and ignored by
git.
