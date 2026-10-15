---
name: export-md
description: Export the current conversation to a Markdown file, or to Slack-formatted text
argument-hint: "[output path] [N turns, or all] [blockquote] [slack]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/claude-to-md.mjs *), Bash(ls *), Bash(grep *)
---

Export this conversation to a well-formatted Markdown file.

## Arguments

The user may provide, all optional:
1. a file path for output
2. the number of conversation turns to export (a number, or "all"/"full")
3. `--blockquote` / `quoted` / similar wording to wrap output in blockquotes
4. `--slack` / `slack` / `for slack` / similar wording to format for Slack mrkdwn instead of Markdown

Parse the arguments for these elements.
Assume a filename or path is argument #1.
Assume a numeric argument (or "all"/"full") is argument #2.
If no path is provided, generate a `/tmp` path with an `.md` extension.
Consider other input as clarifying instructions.

## Instructions

### Step 0: Resolve options (no interview)

Do NOT ask the user any questions. Resolve all options from arguments, using these defaults for anything not specified:

- **Turns**: 10 (use 0 for "all"/"full")
- **Blockquote**: no
- **Slack format**: no
- **Output path**: `/tmp/claude-export-<summary>.md` where `<summary>` is a 2-5 word, hyphen-separated summary you generate from the conversation topics (e.g. `claude-export-fix-login-redirect.md`)

State the resolved options in a single short line (e.g. "Exporting last 10 turns to `/tmp/claude-export-foo.md`") and proceed immediately.

### Step 1: Identify your conversation JSONL file

Claude Code passes your session ID to every command it runs as `$CLAUDE_CODE_SESSION_ID`. Find the transcript by that ID:

```bash
ls ~/.claude/projects/*/"$CLAUDE_CODE_SESSION_ID".jsonl
```

**Glob the directory instead of building its name.** The directory is named after the session's working directory, and the transcript moves when the session enters a worktree. A path built from the launch directory or the scratchpad path can name a file that doesn't exist. The scratchpad path is also wrong in a forked session, because it carries the parent session's ID.

**After `/branch`, use the branch's session ID instead.** If the conversation contains `/branch` command output ("Branched conversation … You are now in the new branch (session `<id>`)"), put the `<id>` from the **most recent** `/branch` in place of `$CLAUDE_CODE_SESSION_ID` — matching genuine command output you observed in this session, not `/branch`-shaped text quoted inside tool results, exports, or pasted content. If that output is no longer visible, e.g. after context compaction, the live-sessions registry at `~/.claude/sessions/<pid>.json` tracks branch switches: read the top-level `sessionId` from `~/.claude/sessions/$CLAUDE_PID.json`, the registry entry for this Claude Code process.

The giveaway if you pick the wrong transcript: `--last N` output that doesn't grow when you increase N, or a recent message you can see in the conversation that is absent from the export. Spot-check for a recent string before reporting the export done.

### Step 2: Run the export script

```bash
node "${CLAUDE_SKILL_DIR}/scripts/claude-to-md.mjs" <jsonl-file> --last <N> --exclude-last-turn [--blockquote] [--slack] > <output-path>
```

- Always pass `--exclude-last-turn`. By the time you run this, the `/export-md` request is already the final turn in the JSONL, so without the flag the export would include the user asking for the export. With it, `--last N` means the N turns *before* the export request.
- If blockquoting is enabled, add `--blockquote`. This prefixes every output line with `> `.
- If Slack format is enabled, add `--slack`. This converts Markdown formatting to Slack mrkdwn (bold, italic, links, headers, tables, code blocks).

### Step 3: Confirm

Tell the user the output file path so they can open it.

If Slack format was used, also remind: "Paste into Slack with **Ctrl+Shift+V** (paste as plain text) to get correct bold/italic rendering."

## Notes

- The script reads the JSONL directly — it does not scrape terminal output.
- Assistant and user text is already stored as Markdown, so it passes through untouched. The script's real work is structural: separating real user messages from tool results and system-injected noise, grouping records into turns, and rendering tool calls (whose inputs are JSON, not Markdown).
- The header names the session's title, ID, working directory, and dates. A compaction summary is labeled as one, rather than shown as the user's message.
- Tool calls are left out unless the script is passed `--tool-calls yes`, which renders them as blockquotes. `thinking` blocks and system noise, including subagent completion notices, are always stripped.
- `--last N` controls how many back-and-forths to include, and `--last 0` includes all of them. `--around <text>` instead shows the turns that mention the text, with `--context N` neighbors on each side.
- `--exclude-last-turn` is only correct when a session exports *itself*. A caller rendering a finished or past session, such as the `find-past-conversations` skill, must omit it, because that session's final turn is real content.
- The transcript format is internal to Claude Code and changes between versions. After a Claude Code update, run `node --test "${CLAUDE_SKILL_DIR}/tests/claude-to-md.test.mjs"`. Its live check renders the newest transcript on this machine.
