---
name: persist-memories
description: Walk through Claude Code's auto memories one at a time and decide what to do with each — promote it into a CLAUDE.md or AGENTS.md, delete it, or leave it where it is.
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, TaskCreate, TaskUpdate, TaskList
---

Claude Code saves auto memories per project, under `~/.claude/projects/<project>/memory/`, with a `MEMORY.md` index whose first 200 lines load into every session started in that project. A lesson saved while working in one project doesn't reach the others. This skill reviews the memories with the user, one at a time, and moves the ones worth keeping into an instruction file that every relevant session loads. Claude Code has no built-in step for that.

## Step 0 — Find the promotion targets

Read `~/.claude/CLAUDE.md`, the user-scope instruction file, and follow its `@path` imports one level at a time. Name the targets that exist, in one line each:

- **Personal:** the file where the user's own, private instructions live. Often that's `~/.claude/CLAUDE.md` itself. If it only imports another file, such as one in a dotfiles repo, the imported file is the target.
- **Shared:** a rules file imported from a repo of instructions shared across machines or people, if there is one. Check whether that repo is public, for example with `gh repo view <owner>/<repo> --json visibility`. A public target can take only rules with nothing personal, employer-specific, or machine-specific in them.
- **Project:** a repo's own `CLAUDE.md` or `AGENTS.md`, chosen per memory in Step 2.

If `~/.claude/CLAUDE.md` doesn't exist, say so, and offer to create it or to skip Personal for this run. Also say if this machine's home directory looks temporary, such as a cloud workspace rebuilt from an image, because then its memories are lost on the next rebuild unless they're promoted.

## Step 1 — Inventory

List every project directory that has memories:

```bash
for memdir in ~/.claude/projects/*/memory/; do
  [ -f "$memdir/MEMORY.md" ] && echo "$memdir"
done
```

Read each `MEMORY.md` and the memory files it indexes. Render one merged, numbered list, not sectioned by project, because the decision is per memory. For each entry:

- **Title,** from the frontmatter `name`
- **Source project directory,** such as `-home-user-my-app`. Delete and cleanup need it later.
- **Type** (user, feedback, project, or reference), from `metadata.type` in the frontmatter, or a top-level `type` in older memories, and **age**, from the file's modification time
- **A one- or two-line summary,** paraphrased

Then group the memories by their likely outcome: Promote (and to which target), Delete, or Leave.

Don't act yet. Wait for the user to say "go" or pick a starting memory.

## Step 2 — One at a time

For each memory, present the options that apply and wait for a decision. Recommend one, with a one-line reason. Don't bundle several memories into one question.

- **Promote to personal:** personal preferences, workflow rules that apply on every machine, how-to's. Name the section of the personal file it belongs in, and propose the bullet text.
- **Promote to shared:** the same, but only for rules that are generic enough for the shared repo. Not for anything that names a person, employer, account, or machine when the repo is public.
- **Promote to project:** rules about the code or conventions of one repo, which help every agent working in it, not only this user. Suggest the closest `CLAUDE.md` or `AGENTS.md` to the code it governs, following the repo's own convention for AI instruction files.
- **Delete:** the memory is already covered by an instruction file, or it was transient, such as the state of a finished task. Say why.
- **Leave:** useful, but specific to this project's directory or this machine.

**Before recommending a promotion, scan the memory for sensitive data:** credentials or tokens, personal data about someone, customer data, or raw log lines and query results pasted in while debugging. If you find any, recommend Delete or Leave, and say why. Every promotion target is easier to share or publish than the local memory directory.

## Step 3 — Carry out the decision

### Promote to personal or shared

- Use `Edit` on the target file. If the file is a symlink, such as into a dotfiles repo, `Edit` follows it, but `Write` would replace the symlink with a regular file. Don't use `Write` on it.
- Turn the memory into a short bullet that leads with the rule. Drop the memory's "Why" and "How to apply" scaffolding, unless the reason is what lets a reader handle an edge case.
- Show the new text for confirmation before saving.
- If the target is in a git repo, say so, and leave committing to the user unless they ask.

### Promote to project

1. Pick the file, as in Step 2. If none exists at that path, create one the way the repo's other instruction files are written.
2. Make the edit on a new branch, and open a draft PR the way the repo normally does it.
3. Optionally, offer to run `/code-review` on the change before the user marks the PR ready.

### Delete

- `rm ~/.claude/projects/<source-project-dir>/memory/<file>.md`, using the source directory from the inventory
- Remove its line from that directory's `MEMORY.md`
- If other memories link to it with `[[<name>]]`, mention them, so the user can decide whether they still make sense

### Leave

No action. Move on.

## Step 4 — Clean up after a promotion

After a promotion succeeds, delete the memory as in "Delete", because the instruction file is now the source of truth, and two copies drift apart. For a project promotion, do this once the PR is open, not when it merges.

If a project PR is later closed without merging, re-create the memory from the conversation if it's still needed. Memory directories aren't tracked in git, so there's no history to recover it from.

## Step 5 — Summary

After the last memory, print a table:

| # | Title | Outcome |
|---|---|---|

Then list what still needs the user: uncommitted edits to instruction files, and draft PRs to review or mark ready.

## Notes

- **Carry each memory's source project directory through the loop.** Delete and cleanup act on one specific `~/.claude/projects/<dir>/memory/`.
- **The frontmatter belongs to the memory system:** `name`, `description`, `metadata`, and fields such as `originSessionId`. Copy only the rule into the target file.
- **Write in the target file's existing style,** and follow the writing rules already in your loaded instructions.
- **Track the loop with `TaskCreate`** when the list is long: one task per memory, completed as each one resolves.
