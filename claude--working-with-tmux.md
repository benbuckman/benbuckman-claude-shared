# Working with tmux and cmux

<!--
How to drive tmux and cmux panes — mainly sending messages to sibling Claude
Code sessions, and reading what another pane shows.
-->

## Sending a message to another Claude Code pane

**Use three separate commands, in this order. `tmux send-keys -t <pane> "<text>" Enter` does not work.**

```bash
cat > /tmp/handoff.md <<'EOF'
First line of the message.

Second paragraph, with its own line breaks preserved.
EOF

tmux load-buffer -b handoff /tmp/handoff.md
tmux paste-buffer -p -b handoff -t '%24'    # -p = bracketed paste; keeps newlines
tmux send-keys -t '%24' Enter                # separate call, or it gets swallowed
```

- **The trailing `Enter` in a `send-keys` call gets absorbed by the paste.** A long string sent with `send-keys` is detected as a bracketed paste by Claude Code's TUI, which renders it as `[Pasted text #1 +N lines]`. An `Enter` in that same command lands inside the paste buffer instead of submitting. The message then sits in the recipient's input, unsent, looking to the sender like it worked. Send `Enter` as its own `tmux send-keys` call.
- **Never trust the exit code as proof of delivery.** `tmux send-keys` exits 0 when tmux accepts the keystrokes, which says nothing about whether the receiving TUI submitted anything. Confirm with `tmux capture-pane -p -t '%24' | tail -15`. A pane still showing `❯ [Pasted text #1 …]` has not sent; a pane showing the message body and a working indicator has.
- **Line breaks survive a bracketed paste, so write a real message, not one run-on line.** Passing multi-line text to `send-keys` risks each newline submitting early, which is why one-lining it is tempting — but `paste-buffer -p` delivers newlines as literal newlines. (Verified at the tmux layer: three lines in, three lines out. The TUI's own `+N lines` counter is consistent with it, though I have not separately proven the TUI's handling.)

## Addressing panes

- **Target by pane ID (`%24`), not by index (`1.4`).** Indexes renumber when panes are added, closed, or moved; IDs are stable for the pane's life. Quote the ID — `'%24'` — so the shell does not eat the `%`.
- **Find the pane by title, not by position:**
  ```bash
  tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}  id=#{pane_id}  title="#{pane_title}"  cwd=#{pane_current_path}'
  ```
  Claude Code panes carry their conversation topic as the title (e.g. `✳ investigating latency`), which is how to match one named in prose. Confirm the mapping before sending — "pane 4" from a human means the index they can see, and it needs translating to an ID.
- **`$TMUX_PANE` is this session's own pane** and can change across a session restore. Do not assume an ID captured earlier is still yours.

## cmux

cmux is a terminal app with its own panes, separate from tmux. On the personal M4, Claude Code runs in cmux. A session is in cmux when `CMUX_SURFACE_ID` is set. The `cmux` command is on the `PATH`, at `/Applications/cmux.app/Contents/Resources/bin/cmux`.

In cmux, a window holds workspaces, a workspace holds panes, and a pane holds surfaces. A surface is one terminal tab. Each Claude Code session, and each shell the user opens, is its own surface. Commands that act on a terminal take a surface.

### Finding a surface

```bash
cmux tree          # the current window
cmux tree --all    # every window
```

The output lists each surface with its ref, title, and terminal device:

```
├── workspace workspace:3 "misc" [selected] ◀ active
│   └── pane pane:3 [focused] ◀ active
│       ├── surface surface:86 [terminal] "◐ `lpass` CLI upgrade" [selected] ◀ active ◀ here tty=ttys000
│       ├── surface surface:89 [terminal] "sudo softwareupdate -i "Command Line Tools for Xcode 27.0-27.0"" tty=ttys019
```

- `◀ here` marks this session's own surface.
- A Claude Code surface carries its conversation topic as its title. A shell surface carries the command it's running, so the user can point at a pane by naming the command in it.
- Run `cmux tree` again before each use of a ref. Whether refs stay the same across a cmux restart hasn't been checked. `--id-format uuids` prints UUIDs instead.

### Reading a surface

```bash
cmux read-screen --workspace workspace:3 --surface surface:89 --scrollback --lines 60
```

`--scrollback` includes lines that have scrolled off the screen. `--lines` limits the output to the last N lines. This form was tested on 2026-10-21. `cmux capture-pane` takes the same options, but it hasn't been tested.

For a Claude Code surface, `read-screen` returns only the visible screen, even with `--scrollback --lines 100000`. Claude Code probably draws on the terminal's alternate screen, which has no scrollback. A session's full history is in its transcript, `~/.claude/projects/<encoded folder>/<session ID>.jsonl`. `cmux surface resume show --surface <ref>` prints the session ID.

### Waiting for a surface to finish

To wait for a long command in another pane, such as an install the user runs with `sudo`, poll `read-screen` from a background Bash call. Claude Code then reports back when the loop exits. Stop on the command's final line, or on the shell prompt coming back:

```bash
for i in $(seq 1 120); do
  out="$(cmux read-screen --workspace workspace:3 --surface surface:89 --lines 15 2>&1)"
  echo "$out" | grep -q -E 'Done with|rror:|Failed' && break
  sleep 10
done
echo "$out"
```

### Sending to a surface

The `new-tmux-agent` skill sends with `cmux send --surface <ref> "<text>"`, then `cmux send-key --surface <ref> enter`. Whether a long `cmux send` gets absorbed as a paste, as `tmux send-keys` does, hasn't been tested. Confirm delivery with `read-screen`, as with tmux.

### Restarting cmux

When cmux relaunches, it rebuilds each workspace and runs `claude --resume <session ID>` in each surface that was running Claude Code. The `terminal.autoResumeAgentSessions` setting controls this, and it's on by default. cmux's agent hooks keep the session records in `~/.cmuxterm/claude-hook-sessions.json`. cmux keeps its layout in `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`.

- `cmux surface resume show --surface <ref>` prints the command cmux will run for one surface.
- `cmux sessions list --agent claude` lists the saved records. A record with `pid_exists=no` belongs to a session that has already ended.
- A restart stops work in progress inside each session: a running turn, background tasks, and scheduled wakeups. The conversation comes back, and the user asks it to continue.
- A plain shell comes back as a new shell.

This comes from cmux's [agent hooks doc](https://github.com/manaflow-ai/cmux/blob/main/docs/agent-hooks.md), read on 2026-10-21 with cmux 0.64.25 installed. It hadn't yet been checked against a real restart.

### Don't print cmux's environment variables

cmux sets many `CMUX_*` variables in each terminal. `CMUX_SOCKET_CAPABILITY` holds a token for the cmux control socket. Don't run `env | grep CMUX`, because it copies the token into the transcript. Print a single named variable, such as `echo "$CMUX_SURFACE_ID"`.

### Help

`cmux --help` lists every command. `cmux <command> --help` describes one. `cmux guide` is written for agents.

## What belongs in a handoff message

A sibling pane cannot see this session's context, so a bare "you own this now" leaves it to rediscover everything.

- **State**: branch, HEAD SHA, worktree path, whether the tree is clean and matches origin.
- **Anything that will make it spin**: a gate that will not go green no matter how many times it retries, a check that fails by design, an approval that is withheld deliberately. Say why, and cite the file that governs it.
- **Decisions already taken and deliberately not reversed**, so it does not undo them — including findings that were declined rather than fixed, with the reasoning.
