---
name: find-past-conversations
description: Search past Claude Code conversations by keyword. Use when the user says "find conversation", "search conversations", "which conversation", "did we discuss", "where did we talk about", "find where we discussed", or wants to locate a previous Claude Code session by topic or keyword.
allowed-tools: Bash(grep *), Bash(python3 -I ${CLAUDE_SKILL_DIR}/scripts/list-claude-conversations.py*), Bash(node ${CLAUDE_SKILL_DIR}/../export-md/scripts/claude-to-md.mjs *)
---

# Find past conversations

Find the past Claude Code sessions that discussed a topic, say what each was about, and give the command to resume it.

The `/resume` picker already filters sessions by title and first prompt, and `Ctrl+A` widens it to every project. This skill is for what the picker can't do: search the text of the conversations.

It uses two scripts:
- **`scripts/list-claude-conversations.py`** lists every session with its title, working directory, branch, PR, age, and the session it was forked from.
- **`claude-to-md.mjs`**, from the [export-md](../export-md/SKILL.md) skill, renders a session's turns as Markdown. Install `export-md` next to this skill.

## Steps

### 1. Get the keywords

Use the skill's arguments, or ask. If the current conversation already covers the topic, ask whether the user means this one.

### 2. Find the sessions that mention them

```bash
grep -l -i -F "<keyword>" ~/.claude/projects/*/*.jsonl
```

- **Use exactly this two-level glob.** Each project directory also holds `memory/*.md` files and `<session>/subagents/*.jsonl` transcripts, which can't be resumed. A recursive grep would match those too.
- **Leave out this session:** its file is `~/.claude/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl`.
- **With several keywords,** grep for each and rank the files where they co-occur first.

### 3. Name each match

```bash
python3 -I "${CLAUDE_SKILL_DIR}/scripts/list-claude-conversations.py" > /tmp/claude-sessions.json
```

The output is a JSON list, newest first. Match each file from step 2 on `path` to get its `title`, `project_dir`, `branch`, `ago`, and `forked_from_id`.

- **`project_dir` is read from the transcript.** Don't rebuild it from the project directory's name, because that encoding turns every `-` into `/` and mangles paths that contain dashes.
- **Forks repeat their parent's text.** A fork's file starts with copies of its parent's events, so a keyword in the shared part matches every session in the family. Report the family together, parent first, and say which sessions continued past the fork.

### 4. Read the matching turns

For the most promising matches, render only the turns around the keyword:

```bash
node "${CLAUDE_SKILL_DIR}/../export-md/scripts/claude-to-md.mjs" <path> --around "<keyword>" --context 1
```

Don't pass `--exclude-last-turn`: a past session's last turn is real content. If `export-md` isn't installed, fall back to `grep -n -i -F "<keyword>" <path>` and read a few lines around each hit.

### 5. Report

For each session:
- **Title, age, and the full session ID.** `claude --resume` doesn't accept a shortened ID.
- **What was discussed,** in your own words, from the rendered turns.
- **Key quotes:** one or two short snippets that show the keyword in context.
- **The resume command:** `cd <project_dir> && claude -r <session-id>`

**Paraphrase rather than quote** when a transcript holds sensitive data, such as credentials, personal details, or customer data that was pasted in while debugging. If the only context that explains a match is sensitive, describe the topic instead.

## Format changes

The transcript format is internal to Claude Code and changes between versions. After a Claude Code update, run `python3 -I -m unittest discover -s "${CLAUDE_SKILL_DIR}/tests"`, and `export-md`'s test too. Each has a live check that reads this machine's transcripts.
