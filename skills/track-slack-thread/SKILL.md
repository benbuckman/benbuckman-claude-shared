---
name: track-slack-thread
description: Keep a Markdown copy of a Slack conversation up to date in a file on a local git branch. On each check it copies the conversation with dump-slack-threads, and only when the conversation changed it commits the file in the checkout of that branch and tells the user, here and optionally by push notification. With every=<interval> it schedules the checks. Use when the user says "/track-slack-thread", "track this Slack conversation in the repo", "keep this Slack copy up to date", or "monitor this conversation and commit changes". For a one-time copy, use dump-slack-threads instead.
argument-hint: "<channel ID or Slack URL> <file path> <branch> [every=<interval>] [since=YYYY-MM-DD] [until=YYYY-MM-DD] [max=N]"
user-invocable: true
---

# Track a Slack conversation in a file on a branch

Keep one Markdown copy of a Slack conversation current, in a file on a local branch. Each check copies the whole conversation to a temp folder, compares it with the committed copy, and commits only when the conversation itself changed. Read [dump-slack-threads](../dump-slack-threads/SKILL.md) first: this skill uses its inputs, its file format, and its checks.

## Inputs

Parse `$ARGUMENTS`. Ask only for what is missing.

- **Target, `since=`, `until=`, `max=`:** the same as dump-slack-threads. The target's URL becomes the copy's Source line.
- **File path, required:** the copy's path relative to the repository root, for example `docs/sources/slack-<name>.md`
- **Branch, required:** the local branch whose checkout holds the file
- **`every=<interval>`, optional:** how often to check. With it, set up a scheduled job and run the first check. Without it, run one check and stop. There is no default interval: if the user asks for tracking without saying how often, ask.

## Setting up, with `every=`

1. **Turn the interval into a cron expression.** Use an off-minute, not :00 or :30, so the checks don't land with everyone else's.

   | `every=` | Cron expression | Example |
   |---|---|---|
   | `Nm`, where N divides 60 | minutes `K-59/N`, with K between 1 and N-1 | `every=15m` → `7-59/15 * * * *` |
   | `Nh` | minute 17, hours `*/N` | `every=1h` → `17 * * * *`, `every=4h` → `17 */4 * * *` |
   | `Nd` | minute 17 past 9, days `*/N` | `every=1d` → `17 9 * * *` |
   | a quoted five-field cron expression | used as given | `every="5 8-18 * * 1-5"` |

   Refuse an interval that the table can't express, such as `7m`, and ask for another.
2. **Schedule the job:** create a recurring `CronCreate` job with that expression. Its prompt is `/track-slack-thread` followed by the same arguments without `every=`, so each run does one check and schedules nothing.
3. **Tell the user about the job:** give them its id and the schedule in words. It runs only while this session is open and idle, it can fire up to 10% of the interval late, and it expires after 7 days. `CronDelete` stops it.
4. **Run the first check,** below

## One check

1. **Find the checkout:** run `git worktree list --porcelain` in the repository, and take the `worktree` path of the entry whose `branch` line is `refs/heads/<branch>`. Call it W.
   - **No entry has the branch:** reply in one line that the branch is not checked out in any local worktree, and stop.
   - **This session is isolated to a different worktree:** its git commands can't reach W, so tell the user and stop.
2. **Copy the conversation to a temp folder:** write `/tmp/track-slack-thread/<file name>`, following dump-slack-threads, including its checks. For each post whose text in Slack matches W's copy, write it exactly as W's copy has it, so that formatting alone never shows up as a change.
3. **Make sure the comparison can work:** W's copy, if it exists, and the temp copy must each have exactly one line that starts with `- **Copied:**`. Without that line, the next step's `sed` deletes the whole file, both sides come out empty, and the check would always find no change. If W's copy lacks it, stop and tell the user.
4. **Compare everything below the Copied line:**

   ```bash
   diff <(sed '1,/^- \*\*Copied:\*\*/d' "W/<file>") <(sed '1,/^- \*\*Copied:\*\*/d' "/tmp/track-slack-thread/<file name>")
   ```

   This ignores the header, whose Copied time changes on every run. It catches posts added, removed, or edited. If W has no copy of the file, count that as a change.
5. **No difference:** do nothing more. Reply only "No changes in the Slack conversation."
6. **A difference:**
   1. **Formatting only:** if the only differences are in how unchanged posts are formatted, fix the temp copy to match W's and compare again
   2. **Sensitive data:** if a new or changed post contains sensitive personal data, such as health details, dates of birth, or identification numbers, stop and tell the user, and copy nothing
   3. **Someone else's edit:** if `git -C W status --short -- <file>` shows the file staged or modified (anything other than `??` or no output), stop and tell the user
   4. **Commit:** copy the temp file over `W/<file>`. Run `git -C W add -- <file>`, then commit only that file with `git -C W commit -F <message file> -- <file>`, so nothing else staged in W is included. Follow the branch's recent commit subjects, such as a ticket-key prefix, then "Refresh the Slack copy of <conversation name>". End the message with the co-author trailer from the session's attribution instructions.
   5. **Tell the user here,** in one line: how many posts were added, removed, or edited, and the commit SHA
   6. **Send a push notification, if the user's own instructions name a way to send one,** such as an ntfy topic. Skip this step otherwise. Include no Slack message text and no sensitive data. For example: "Slack copy updated: <N> posts added or changed in <conversation name>. Committed <short SHA> on <branch>, not pushed."

## Rules

- **Never push.** The user pushes the branch.
- **Touch only the tracked file:** in W, write and commit nothing else. W may be a checkout where another session is working.
- **Read-only in Slack:** do not post, react, or mark anything as read
