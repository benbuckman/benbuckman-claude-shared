# Working with tmux

<!--
How to drive tmux panes — mainly sending messages to sibling Claude Code
sessions.
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

## What belongs in a handoff message

A sibling pane cannot see this session's context, so a bare "you own this now" leaves it to rediscover everything.

- **State**: branch, HEAD SHA, worktree path, whether the tree is clean and matches origin.
- **Anything that will make it spin**: a gate that will not go green no matter how many times it retries, a check that fails by design, an approval that is withheld deliberately. Say why, and cite the file that governs it.
- **Decisions already taken and deliberately not reversed**, so it does not undo them — including findings that were declined rather than fixed, with the reasoning.
