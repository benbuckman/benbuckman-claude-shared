# Ben's Claude instructions

Generic, reusable [Claude Code](https://claude.com/claude-code) configuration: preference files, auxiliary instruction documents, and skills.

This repo is a distillation of my Claude instructions, evolved over the last ~2 years. Some of it was hand-written, and some written by Claude itself (prompted by me, in response to various mistakes I wanted to not repeat).

As always, Claude's handling of these instructions differs by model, effort level, etc and is constantly changing.

Everything here is deliberately **free of employer, project, and machine specifics** — those belong in whatever private repo layers on top.

## Layout

| Path | Loaded |
|---|---|
| `AGENTS.md` | by agents that look for that name; it points at `CLAUDE.md` |
| `claude--voice.md` | always |
| `claude--workflow-preferences.md` | always |
| `claude--working-with-code.md` | on demand |
| `claude--working-with-git.md` | on demand |
| `claude--working-with-tmux.md` | on demand |
| `skills/` | per Claude Code's skill discovery |

## Always-loaded vs on-demand

Claude Code auto-imports any path written as `@path/to/file.md`, pulling it into context at the start of every session. That is right for preferences that always apply, and wasteful for reference material that matters only when a topic comes up. Splitting into imports helps organization but does not reduce context — imported files load at launch either way.

So this repo distinguishes the two, and `CLAUDE.md` is the manifest that does it. Always-loaded files are `@`-imported; on-demand ones are named in backticks, which Claude Code treats as literal text rather than an import. That is the only part of the arrangement that actually reclaims context.

## Consuming this repo

Import the manifest from your own `CLAUDE.md` and layer your own context on top:

```markdown
@~/path/to/benbuckman-claude-shared/CLAUDE.md

<!-- machine- and project-specific instructions below -->
```

Imports inside this repo are relative, and Claude Code resolves a relative import against the file containing it, so nothing here assumes where you cloned it.

Two limits worth knowing:

- **Imports nest four deep at most.** The manifest is one hop from your file and its imports are two, leaving room for one more level in your own config.
- **Target under 200 lines per file.** Adherence drops as files grow. The always-loaded set here is about 115 lines including the manifest.

Prefer `~/.claude/CLAUDE.md` over `~/CLAUDE.md` in your home directory. The former is a documented user-scope location whose imports load without an approval prompt, regardless of your working directory. The latter is picked up only because Claude Code walks up the directory tree, which makes it conditional on where you started.

## A note on HTML comments

Block-level `<!-- -->` comments are stripped from CLAUDE.md files before they reach Claude, and stay visible to anyone reading the file. Use them for notes to human maintainers — anything Claude cannot act on is otherwise paying rent in every session. This repo keeps its own explanation in this README for the same reason.

## No personal data

This repo is public and deliberately carries none: no names, email addresses, employers, locations, account handles, or machine identifiers, in the content or in the examples. Identity and environment belong in the private `CLAUDE.md` that imports this one, where they are also more useful — that file can say what is true of a particular person, machine, and job.

## Why a separate repo

Personal dotfiles carry machine paths, employer tooling, and private preferences. Prising the genuinely general guidance out into its own public repo means one canonical copy, shareable, with the private layers importing it rather than duplicating it.

## License

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see [LICENSE](LICENSE) for the full legal text.

You may share and adapt anything here, for any purpose including commercially. The one condition is attribution: give credit, link the license, and say if you changed things. Unlike a code license that only asks for a notice when you copy a substantial portion, this applies to reuse of any size — lifting a handful of rules into your own `CLAUDE.md` counts.

Something like this is plenty:

> Adapted from [benbuckman-claude-shared](https://github.com/benbuckman/benbuckman-claude-shared), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Attribution can be given in any reasonable manner, so long as it doesn't imply I endorse you or what you built.

`SPDX-License-Identifier: CC-BY-4.0`
