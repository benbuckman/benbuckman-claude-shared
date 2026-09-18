# Agent instructions

The instructions for this repository live in [CLAUDE.md](CLAUDE.md), beside this file. Read that file and follow it. It loads two preference files at the start of every session, and names three more to read when their subject comes up.

@./CLAUDE.md

<!--
This file exists for agents that look for AGENTS.md by name. Claude Code is not
one of them. It reads CLAUDE.md and ignores AGENTS.md, so CLAUDE.md stays the
one manifest and this file points at it rather than repeating it.

The `@./CLAUDE.md` line is for tools that expand `@path` imports. A tool that
does not expand it still reads the sentence above, which says the same thing in
prose. Keep both, and keep this file short enough that a tool reading it
verbatim loses nothing by doing so.
-->
