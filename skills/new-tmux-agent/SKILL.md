---
name: new-tmux-agent
description: Open a new independent Claude Code session in a sibling pane, in tmux or cmux, with an initial prompt loaded. Use when the user says "make a new tmux agent", "make a new independent agent", "make a new sibling agent", "open a new claude session in a new pane", "spawn a new claude in tmux", or any phrasing about starting a peer-level Claude session next to this one. This is for FIRST-CLASS sibling agents only — do NOT invoke for sub-agents (use the Agent tool), background agents, or agent teams. Those are different mechanisms.
allowed-tools: Bash(tmux *), Bash(cmux *), Bash(claude *), Bash(git *), Bash(cat *), Bash(ls *), Bash(mkdir *), Bash(test *), Bash(command *), Read, Write
---

# Make a new first-class sibling Claude agent in a pane

Open a new `claude` session in a sibling pane, running independently from the current session. The new agent has its own conversation context — it's a peer, not a sub-agent. The user can switch to it, talk to it directly, and give it its own flags, such as `--model` and `--effort`, which a sub-agent can't take.

If the user's request is ambiguous between this and a sub-agent, ask: "Do you want an independent claude session in a new pane (you'd switch panes to talk to it), or a sub-agent that reports back to this conversation?" The phrasing "first-class" / "sibling" / "tmux" / "new pane" / "new session" strongly signals this skill.

## Inputs

The user may provide:
- **A file path** — the new agent's initial prompt content lives in that file. Most common case.
- **Inline prompt text** — the user types or pastes the prompt directly. Write it to a temp file first.
- **A name**, and **flags** for the new session, such as `--model` or `--effort`.
- **A target** — a **pane is the default and almost always what's wanted**: a split to the right (default) or below, in the current window. A **new window** is rare, and only on request (see step 4).
- **A worktree** — if the agent should work in a git worktree, **do NOT start `claude` with its cwd inside the worktree.** Start it from the repo root, and have the agent switch in itself via `EnterWorktree` (see step 3). Booting claude inside the worktree gives the session the wrong project/settings context.

If the user said "make a new tmux agent" with no other context, **ask** which initial prompt to feed it.

## Workflow

### 0. Find the terminal multiplexer

```bash
if [ -n "${CMUX_SURFACE_ID:-}" ] && command -v cmux >/dev/null; then echo cmux
elif [ -n "${TMUX:-}" ]; then echo tmux
else echo none; fi
```

- **cmux**: use the cmux commands below. cmux sets `CMUX_SURFACE_ID` in every terminal it runs. `cmux tree` shows the current window's workspaces, panes, and surfaces.
- **tmux**: use the tmux commands. Report where the new pane will appear: `tmux display-message -p 'current: session=#S window=#W pane=#P'`
- **Neither**: refuse with a clear message. Don't start a detached tmux session, because the user wouldn't see it.

### 1. Resolve the prompt file

- **File path provided**: verify it exists with `test -f "$PROMPT_FILE"`. If not, ask the user.
- **Inline prompt provided**: write it to a temp file, e.g. `/tmp/new-tmux-agent-prompt-$(date +%s).md`.
- **Nothing provided**: ask the user. Don't guess.

### 2. Resolve the repo root

```bash
REPO_ROOT=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
```

That is the main checkout, even when this session is inside one of its worktrees. Outside a git repo, use the current directory. Only start the new session somewhere else if the user asks.

### 3. If the agent should work in a worktree

Create the worktree under `$REPO_ROOT/.claude/worktrees/<branch>` first, with `git -C "$REPO_ROOT" worktree add`. Start `claude` from `$REPO_ROOT`, and in the agent's **prompt** tell it to run `EnterWorktree(path="$REPO_ROOT/.claude/worktrees/<branch>")` as its first action, then work there. This gives the session the canonical project context (settings, memory, project root) and *then* moves it into the worktree.

**The worktree must be under `<repo>/.claude/worktrees/`, or the new agent blocks on a manual approval.** Claude Code treats that directory as its trusted worktree root. `EnterWorktree` with a path anywhere else raises an approval prompt in the new pane, which no `permissions.allow` rule, hook, or auto mode can pre-approve, so the agent sits idle until the user switches panes and answers. If the user names an existing worktree somewhere else, use it as it is, and tell the user the new pane will wait for that approval.

### 4. Create the pane — open a shell FIRST, then launch claude

Open the pane as a **plain shell first**, name it, then start claude inside it by typing the command. Shell-first means that when the user `/exit`s claude, the pane **drops back to the shell instead of closing**, so the session isn't lost: they can `claude --resume` right there. A pane whose own command is `claude …` closes the instant claude exits.

The launch command is the same in both multiplexers:

```bash
LAUNCH="cd '$REPO_ROOT' && claude --name '<name>' <user's flags> < '$PROMPT_FILE'"
```

`claude --name` sets the session's display name in the prompt box, the `/resume` picker, and the terminal title. The prompt arrives through the `< file` redirect, from a real file, so there is no paste-timing problem.

**cmux** — a split to the right of this pane, without moving focus:

```bash
NEW=$(cmux new-split right --focus false | grep -o 'surface:[0-9]*' | head -1)   # 1. open a shell
cmux rename-tab --surface "$NEW" "<name>"                                     # 2. name it
cmux send --surface "$NEW" "$LAUNCH"                                          # 3. type the launch command
cmux send-key --surface "$NEW" enter                                          #    and run it
```

Use `down` instead of `right` for a pane below. Check that `$NEW` is a `surface:<n>` ref before sending to it, and confirm with `cmux tree` that the new surface exists. Don't trust the printed ref of later commands alone.

**tmux** — a horizontal split, to the right, in the same window:

```bash
NEW_PANE=$(tmux split-window -h -c "$REPO_ROOT" -P -F '#{pane_id}')   # 1. open a shell
tmux select-pane -t "$NEW_PANE" -T "<name>"                          # 2. name it before launching
tmux send-keys   -t "$NEW_PANE" "$LAUNCH" Enter                      # 3. launch claude
```

Use `split-window -v` for a pane below.

**A new window, only if the user explicitly asked for one.** In tmux, pass `-d`, because `new-window` otherwise **steals focus**, and the current window's panes seem to disappear. Window names also need `automatic-rename off`, or tmux overwrites the name with the running command:

```bash
tmux set-option -g automatic-rename off
NEW_WINDOW=$(tmux new-window -d -c "$REPO_ROOT" -P -F '#{window_id}')
tmux rename-window -t "$NEW_WINDOW" "<name>"
tmux send-keys     -t "$NEW_WINDOW" "$LAUNCH" Enter
```

In cmux, the equivalent of a window is a new workspace: `cmux new-workspace --name "<name>" --cwd "$REPO_ROOT" --focus false`, then `send` the launch command to its surface as above.

**About pane titles:** once claude boots, it retitles its pane to the conversation's topic, such as `✳ investigating latency`, which usually makes a useful label anyway. In tmux, a window name with `automatic-rename off` stays put. `tmux set -w -t "$NEW_PANE" allow-rename off` also stops claude retitling, for every pane in that window.

### 5. Report back

Tell the user where the new session lives and how to switch to it:

```
New claude session: surface <ref> (cmux)
Switch: click it, or cmux focus-pane --pane <pane ref from cmux tree>
```

```
New claude session: pane <id> (tmux)
Switch: prefix + arrow key (default prefix is Ctrl-B), or tmux select-pane -t <id>
```

To message the new session later, see `claude--working-with-tmux.md` in this repo. Claude Code's `ListAgents` and `SendMessage` tools can also reach other local sessions.

### 6. Optionally check that it started

If the user wants confirmation, take one snapshot after a couple of seconds. Don't loop.

```bash
cmux read-screen --surface "$NEW" --lines 5      # cmux
tmux capture-pane -t "$NEW_PANE" -p | tail -5    # tmux
```

## Edge cases

- **`claude` not on PATH**: report and stop.
- **File path with shell special characters**: single-quote the path inside the launch command, as in `$LAUNCH` above.
- **The user wants the prompt shown but not auto-submitted**: start `claude` with no redirect, then paste the content into its input box (`tmux paste-buffer`, or `cmux send` without the Enter key), so the user can review it and press Enter. This is rare. Ask if unsure.
- **The user wants the new session to share state with the current one** (e.g., resume the same conversation): not what this skill does. Suggest `claude --resume`, or `/branch` in the current session.

## Anti-patterns (what NOT to do)

- **Don't use the `Agent` tool here.** This skill starts a peer process in a pane, not a sub-agent of the current conversation.
- **Don't paste or type the prompt _content_.** Type only the launch _command_. The prompt rides in through the `< file` redirect. Typing a multi-line prompt into the input box is the fragile thing to avoid.
- **Don't `sleep` to wait for claude to "be ready"**. The `< file` redirect handles the handoff. Only take a snapshot if the user asked for one.
- **Don't make the pane's own command `claude …`** (e.g. `tmux split-window "claude < file"` or `cmux new-split right --command "claude …"`). The pane then closes the instant claude exits.
- **Don't create a new tmux session or cmux workspace** unless the user asked. The default is a pane next to this one — that's what "sibling" means.
- **Don't boot `claude` with its cwd inside a worktree.** Start it from the repo root and have the agent run `EnterWorktree` itself (step 3).

## Examples

**User**: "Make a new tmux agent with the prompt in `prompts/audit-prompt.md`"

→ Find the multiplexer, verify the file exists, then (in tmux):
```bash
REPO_ROOT=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
NEW_PANE=$(tmux split-window -h -c "$REPO_ROOT" -P -F '#{pane_id}')
tmux send-keys -t "$NEW_PANE" "cd '$REPO_ROOT' && claude < '$REPO_ROOT/prompts/audit-prompt.md'" Enter
```

**User**: "Make a new sibling agent named 'foo agent' with high effort, to work in the worktree for branch `foo`, with this prompt: ..."

→ Create `$REPO_ROOT/.claude/worktrees/foo` if it doesn't exist. Write the inline prompt to `/tmp/new-tmux-agent-prompt-<ts>.md`, **including an instruction for the agent to `EnterWorktree(path="$REPO_ROOT/.claude/worktrees/foo")` as its first action**. Then, in cmux:
```bash
NEW=$(cmux new-split right --focus false | grep -o 'surface:[0-9]*' | head -1)
cmux rename-tab --surface "$NEW" "foo agent"
cmux send --surface "$NEW" "cd '$REPO_ROOT' && claude --name 'foo agent' --effort high < '/tmp/new-tmux-agent-prompt-<ts>.md'"
cmux send-key --surface "$NEW" enter
```

**User**: "Make a new tmux agent"

→ Ask: "What prompt should I feed it? (file path, or paste inline)"
