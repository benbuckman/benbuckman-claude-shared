---
name: review-branch-status
description: Review the status of a local branch — PR state, remote tracking, commit log, and whether its changes already exist on the repo's default branch. Use when the user says "review branch", "branch status", "what's on this branch", "is this branch merged", "check branch", or wants to understand what a branch contains and whether it's still relevant.
allowed-tools: Bash(git *), Bash(gh *)
---

# Review Branch Status

Analyze a local branch to understand its current state: what changes it contains, whether it has a PR, whether it exists on the remote, and whether its changes are already on the default branch.

## Inputs

The user may provide any of:
- A **branch name** directly
- A **PR URL or number** (resolve to branch via `gh pr view`)
- Nothing — use the current branch, or ask

If no branch is specified and the current branch is the default branch, ask the user which branch to review.

## Workflow

### 1. Find the default branch

Don't assume `main` or `master`. Ask the remote:

```bash
git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'
```

If that fails, because the clone never recorded the remote's default branch, ask GitHub:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If both fail, ask the user. Store the result as `DEFAULT_BRANCH`.

### 2. Identify the branch

```bash
# If no branch specified:
git branch --show-current

# If PR URL/number provided:
gh pr view <number> --json headRefName --jq '.headRefName'
```

Store the branch name for all subsequent steps.

### 3. Check remote existence

```bash
git fetch origin
git ls-remote --heads origin <branch-name>
```

Report whether the branch exists on the remote.

### 4. Check for an associated PR

```bash
gh pr list --head <branch-name> --state all --json number,title,state,url,mergedAt,closedAt,isDraft --jq '.'
```

Report:
- Whether a PR exists
- PR number, title, URL
- State: **open**, **merged**, or **closed** (and when)
- Whether it's a draft

If no PR exists, say so.

### 5. Find the merge-base with the default branch

Compare against `origin/$DEFAULT_BRANCH`, which step 3 just fetched, rather than the local copy, which may be stale.

```bash
git merge-base origin/<DEFAULT_BRANCH> <branch-name>
```

Store this as `MERGE_BASE` for subsequent steps.

### 6. Show the commit log

```bash
git log --oneline <MERGE_BASE>..<branch-name>
```

Display this to the user. Also report:
- **Number of commits** on the branch since diverging from the default branch
- **Most recent commit date**:
  ```bash
  git log -1 --format='%ci' <branch-name>
  ```

### 7. Show a summary of changes

```bash
git diff --stat <MERGE_BASE>..<branch-name>
```

Display the diffstat so the user can see which files were changed and how much.

### 8. Check if changes already exist on the default branch

This is the key question: are the branch's changes already on the default branch (e.g., merged via squash, cherry-picked, or landed in a different PR)?

```bash
# Check if the branch tip is an ancestor of the default branch (fully merged)
git merge-base --is-ancestor <branch-name> origin/<DEFAULT_BRANCH> && echo "FULLY_MERGED" || echo "NOT_MERGED"
```

If **not** fully merged, do a subject-level comparison to detect squash-merges or cherry-picks. Match subjects as fixed strings, because subjects often contain characters such as `[` that `--grep` would otherwise read as a pattern:

```bash
git log <MERGE_BASE>..<branch-name> --format='%H %s' | while read -r hash subject; do
  match=$(git log <MERGE_BASE>..origin/<DEFAULT_BRANCH> --fixed-strings --grep="$subject" --format='%h' | head -1)
  if [ -n "$match" ]; then
    echo "LIKELY ON DEFAULT BRANCH: $hash ($subject) matches $match"
  fi
done
```

Also check the PR state from step 4 — if the PR is merged, the changes are definitively on the default branch.

Report one of:
- **Fully merged**: branch tip is an ancestor of the default branch
- **PR merged**: PR shows as merged (squash-merge likely)
- **Likely merged**: commit subjects match commits on the default branch
- **Not merged**: changes appear to be unique to this branch

### 9. Summary

Present a concise summary:

```
Branch: <branch-name>
Remote: exists / does not exist
PR: #<number> (<state>) — <url>  OR  no PR
Commits: <N> commits since diverging from <DEFAULT_BRANCH>
Latest commit: <date>
On <DEFAULT_BRANCH>? <status from step 8>

Commit log:
<git log --oneline output>

Changes:
<diffstat output>
```

## Error Handling

- If the branch doesn't exist locally, check if it exists on the remote and offer to check it out.
- If `gh` commands fail (e.g., no GitHub auth), skip PR checks and report what's available from git alone.
