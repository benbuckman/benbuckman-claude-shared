---
name: tmux-synthesize
description: Ask the Claude sessions in the user's tmux or cmux panes to each write a status report (what they did, what they're in the middle of, what's remaining), print who has reported every minute, then verify and synthesize the reports into one picture of overlaps, conflicts, and decisions waiting on the user. Has an incremental mode that asks the same sessions only for what changed since their last report. Use when the user says "/tmux-synthesize", "get a report from every session", "what are all my sessions working on", or "roundup of my tmux agents"; for the incremental mode, "/tmux-synthesize update", "what's changed since the last roundup", or "update the roundup".
argument-hint: "[update [<previous run folder or ISO timestamp>]] [session names or pane IDs to include]"
user-invocable: true
---

# Collect and synthesize reports from sibling tmux or cmux sessions

This session (the caller) finds the Claude sessions that have a live tmux pane or cmux surface, lets the user pick which ones to ask, sends each a report request through cross-session messaging, prints progress every minute, and writes one synthesis.

There are two modes:

- **Full** (the default): steps 1 to 8 below.
- **Incremental** (`update` in `$ARGUMENTS`, or the user asks what changed since the last roundup): the same sessions report only what changed since their previous report. See [Incremental mode](#incremental-mode), which changes steps 1, 2, 3, 5, and 8.

Send messages with `SendMessage`, not by pasting into panes with `tmux send-keys`. A message by name doesn't touch the pane's input box, waits in a queue if the session is busy, and doesn't need screen scraping to confirm.

## 1. Discover the sessions

Collect three sources, then join them. The panes come from whichever multiplexer is running: cmux if `CMUX_SURFACE_ID` is set, tmux if `TMUX` is. Both can be running at once.

**tmux panes:**

```bash
tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_command} #{session_name}:#{window_index}.#{pane_index} title="#{pane_title}" cwd=#{pane_current_path}'
# For each pane: its shell and the shell's children. (--ppid is Linux-only. On macOS, use pgrep -P <pane_pid>.)
ps -o pid,etime,args -p <pane_pid>; ps --ppid <pane_pid> -o pid,etime,args
```

**cmux surfaces:**

```bash
cmux tree --all                      # each surface's ref, title, and tty, such as tty=ttys006
ps -t <tty> -o pid=,etime=,args=     # the claude process running in that surface
```

A cmux surface's title is the conversation's title, which can differ from the session's name in `ListAgents`. Match by process, not by title: the `claude` process on the surface's tty has a `~/.claude/sessions/<pid>.json`, which gives its `sessionId` and `name`.

- **`ListAgents`:** the peer sessions, each with its name, `[ref]`, kind (interactive or bg), status, and the `tmux` pane for interactive ones in tmux
- **`~/.claude/sessions/<pid>.json`:** one file per Claude process, with `sessionId`, `kind`, `tmux`, `jobId`, `parkedJobId`, `name`, `formerNames`, `status`, and `cwd`. Read the `.json` files only. Never read the `.key` files beside them.

Map each pane to a session:

- **An interactive session in tmux** lists its pane in `ListAgents` and in its `.json` `tmux` field.
- **An interactive session in cmux** has `tmux: null`. Map it through its surface's tty, as above.
- **A pane whose command is `bash`** may run `claude attach <jobId>`. That pane shows the bg session whose `.json` has that `jobId`.
- **An interactive process with `parkedJobId`** shows that bg job in its pane. The parked process itself isn't in `ListAgents` and has a stale name. Address the bg session, never the parked process.
- **A bg session that no pane attaches to** is truly in the background. Leave it out unless the user asks for it, and mention it.

Leave the caller out of the list. Step 4 decides whether the caller reports.

## 2. Let the user select

If the user already selected sessions in this conversation, or named them in `$ARGUMENTS`, use that selection.

Otherwise, ask with `AskUserQuestion`, `multiSelect: true`. It allows at most 4 options per question and 4 questions, so group the sessions, for example by lineage or topic. Each option's description gives the pane ID or cmux surface ref, and what distinguishes the session.

If the user asks to rediscover after selecting, keep the earlier selection and exclusions. Only sessions that are new since then are new choices.

## 3. Set up the reports folder

Create `/tmp/tmux-synthesize/<YYYY-MM-DD-HHMM, UTC>/`. It has to be in `/tmp` because every session writes to it, and the caller's scratchpad is private to the caller.

Write `MANIFEST.md` there. It starts with these lines, which the incremental mode reads:

```
Requested at: <ISO 8601 UTC, the time the requests are sent>
Mode: full | incremental
Previous run: <folder>          (incremental only)
```

Then one row per session: the expected file (a short slug such as `api-docs.md`), the session's `name [ref]`, its session ID, and its pane or surface. Keep the slug stable across runs, because the incremental mode matches sessions to their previous reports by slug.

## 4. Decide whether the caller reports

If the caller did substantial work before this request, it writes its own report into the folder, by the same template. If it only did discovery, it doesn't, and it says so in the synthesis.

## 5. Send the requests

Send one `SendMessage` per session, all in parallel. Address each as `"<name> [<ref>]"`. The ref removes doubt when one name is a prefix of another, or when names are long.

Each message contains:

- **A first line that stands alone:** "The user asked for a status report from you: what you did, what you're in the middle of, and what's remaining. Write it to `<folder>/<file>`."
- **Who is asking:** the caller's name, and that it will synthesize the reports.
- **How to write it:**
  - Draft to `<file>.partial`, then rename it to `<file>` when finished. The rename is the signal that the report is done.
  - Finish the current step first, and start no new work for this request.
  - Writing the report is the only change: no code edits, commits, or pushes.
  - When done, send the caller a one-line `SendMessage`.
- **Sections:**
  1. Identity: session name, session ID, worktree, branch, PR, and tickets, each ticket ID with its title. Tell the session its own display name, because a session may not know it.
  2. Relationships
  3. Done
  4. In progress
  5. Remaining
  6. Open questions or decisions waiting on the user, each with an owner
  7. Overlaps or conflicts with other sessions' work
- **Lineage:**
  - Don't report a parent's work as your own. Assume the parent writes its own report.
  - Name each child (a branch, fork, or spawned session) and summarize what you know it did in a sentence or two. The child reports its own details.
  - If a child isn't part of this round, it won't report, so the parent summarizes it a little more fully.
  - State the lineage the caller inferred, from `⑂` in titles, `formerNames`, and `parkedJobId`, and ask the session to correct it.
- **What to leave alone:** anything sensitive in the session's pane, such as text typed in its input box but not sent.
- **Style:** like a reference doc, with files, PRs, and commits linked. Mark what was verified and what was inferred.

## 6. Print status every minute

Start a `Monitor` with `timeout_ms: 1800000`. When it expires with reports still missing, re-arm it.

```bash
D=<folder>; F="<slug1> <slug2> ..."; N=<count>
while true; do
  done_n=0; line=""
  for f in $F; do
    if [ -f "$D/$f.md" ]; then s="done"; done_n=$((done_n+1))
    elif [ -f "$D/$f.md.partial" ]; then s="drafting"
    else s="waiting"; fi
    line="$line $f=$s;"
  done
  echo "$(date -u +%H:%M:%S) $done_n/$N done:$line"
  [ "$done_n" -eq "$N" ] && { echo "ALL REPORTS IN"; exit 0; }
  sleep 60
done
```

Print each status event to the user as a short table. Read each report as soon as its session says it's done, so the synthesis doesn't wait on the last one.

## 7. Verify before synthesizing

A self-report can be wrong. In the worked example, two sessions said they had unpushed commits that were already on origin, and one carried a count that was out of date. Check every claim that conflicts with another report, and every claim the user would act on.

- **Push state:** `git merge-base --is-ancestor <sha> origin/<branch>`, and `git log --oneline origin/<branch>..HEAD`
- **Counts and facts in code:** recount at the revision the claim names and at current master
- **Authorship:** if the repo's commits carry a provenance trailer naming the Claude session, such as `Claude-Session: <id>`, use it. Where every Claude commit carries one, a commit without it was likely made by hand.

## 8. Synthesize

Write `SYNTHESIS.md` in the run folder, then print it. It contains:

1. **Session map:** a lineage tree with each session's pane and short session ID, and the sessions that aren't in this round
2. **Workstreams:** one entry per line of work, a few sentences each
3. **Overlaps and conflicts:** shared files, shared sheets or pages, and contradictory claims, each marked **[verified]** or left as reported
4. **Waiting on the user:** decisions from every report, deduplicated and grouped, each with an owner
5. **Housekeeping with no owner:** loose ends that no session claims

Then offer, in one line, to publish the synthesis as an artifact.

## Incremental mode

Ask the sessions from a previous run what changed since their last report, and update the synthesis.

### Find the previous run and each session's cutoff

- **Previous run:** the folder in `$ARGUMENTS`, or else the newest folder in `/tmp/tmux-synthesize/` that has a `SYNTHESIS.md`. If `$ARGUMENTS` gives an ISO timestamp instead, use it as every session's cutoff, and use the newest run before it for the session list.
- **Each session's cutoff:** the modification time of its previous report, `date -u -r <prev>/<slug>.md +%FT%TZ`. That's when the session finished writing it, so it's more precise than the run's `Requested at`. Fall back to `Requested at` if the file is missing.

A session may have done a little work between the request and its report, which its report already covers. A small overlap like that is harmless. Tell sessions to include an item when they're unsure whether they reported it.

### Changes to steps 1 and 2

- **Start from the previous manifest's sessions,** not a fresh selection. Re-run step 1's discovery only to check that each one is still alive, and to find its current `name [ref]`. A session may have been renamed. Match it by session ID in `~/.claude/sessions/*.json`, or by `formerNames`.
- **A session that has ended** gets no request. List it in the synthesis as ended, with its last known state taken from its previous report.
- **New sessions with a live pane** that weren't in the previous run: ask the user, with `AskUserQuestion`, whether to add them. An added session gets a full request, by step 5.
- **Exclusions carry over.** Don't offer again a session that the user excluded from the previous run.

### Changes to step 3

Create a new run folder. Its manifest says `Mode: incremental` and `Previous run: <folder>`, and each row also records that session's cutoff. Use the same slugs as the previous run.

### Changes to step 5

The first line: "The user asked for an update on your status since `<cutoff>`, when you finished your last report. Write it to `<folder>/<file>`."

Also include:

- **The path of its previous report,** so it can read what it said last time.
- **How to find its own work since the cutoff:** for example, `git log --since=<cutoff>`, filtered by a session trailer if the repo uses one, its own transcript, and the docs and sheets it edits.

Sections:

1. **Identity:** only what changed (a branch, PR, or ticket), or "unchanged"
2. **Relationships:** only new branches, forks, or spawned sessions, or "unchanged"
3. **Done since `<cutoff>`**
4. **In progress now**
5. **Remaining:** the full current list, not only the changes, with each item marked *new*, *carried over*, or *done* compared with the previous report. Leave the done ones in, marked, so the caller can retire them.
6. **Open questions:** the full current list, marked the same way, plus any decisions the user made since the cutoff, quoted where possible
7. **Overlaps or conflicts:** new ones, and previous ones that are now resolved

Sections 5 and 6 list the full current state. That way the synthesis can stand on its own, without stitching deltas onto the previous one.

If nothing changed, a one-line report saying so is enough, and the session still renames the file.

### Changes to step 7

Check the commits since each cutoff, by session ID where the repo records one, and confirm that every item a report marks *done* really happened. For example, a push is on origin, or a PR is merged.

### Changes to step 8

`SYNTHESIS.md` in the new folder leads with **What changed since `<previous run's Requested at>`**:

- **Resolved:** items from the previous synthesis's "Waiting on the user", conflicts, and housekeeping that are now done or decided
- **New:** new work, conflicts, and questions
- **Still open:** carried over, with how long each has been open

Then the five full sections, as in step 8, updated. Housekeeping items that had no owner in the previous synthesis carry forward until someone does them.

## Pitfalls

- **Delivery can be held.** A session in a different permission mode from the caller holds cross-session messages for approval. A `[Cross-session delivery notice]` says so. A successful send means the message reached the inbox, not that the session read it.
- **A busy session reads the message at its next tool call,** not right away. Tell it to finish its current step first.
- **`tmux send-keys` and `cmux send` are not the messaging path.** A pasted message is appended to whatever is typed in the input box, and confirming it needs screen scraping.
- **Sessions share files.** Several sessions on one branch may edit the same documents and sheets, so the overlaps section usually has the most useful findings.
