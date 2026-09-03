# Shared Claude Code configuration

<!--
A manifest: it decides which files load automatically. Each concern lives in
its own file rather than here.

Explanation aimed at humans — how to adopt this, why the always/on-demand split
exists, what the import limits are — lives in README.md, deliberately not here.
Everything in this file outside an HTML comment is loaded into context at the
start of every session that imports it, so prose that Claude cannot act on is
prose that costs tokens forever. Comments like this one are stripped before the
file reaches Claude, and stay visible to anyone reading the file.

NO PERSONAL DATA IN THIS REPO. It is public. Nothing here should carry a real
name, email address, phone number, employer, physical location, account
handle, hardware identifier, or anything else that identifies a person —
whether mine or anyone else's. That includes examples: use placeholders.

Identity belongs in the private CLAUDE.md that imports this one, where it is
also more useful, because it can say what is true of that machine and context.
A claude--about-me.md lived here briefly and was removed for this reason.
-->

## Always loaded

@./claude--workflow-preferences.md
@./claude--voice.md

## Read when relevant

Read these when their subject comes up. The paths are in backticks so they are
referenced rather than imported, and cost nothing until opened.

- Writing code — typing, SQL, handing shell commands back to me:
  `./claude--working-with-code.md`
- Git and GitHub — branching, rebasing, PRs, review comments:
  `./claude--working-with-git.md`
- tmux — driving panes, messaging sibling Claude Code sessions:
  `./claude--working-with-tmux.md`
