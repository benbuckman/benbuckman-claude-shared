#!/usr/bin/env bash
# sitrep.sh — Quick workspace situation report
#
# Set SITREP_TZ (for example, America/Chicago) to print the time in a zone other
# than the machine's local one.
#
# The "Stack" section comes from git-spice's `gs ls`, its short log. It is
# skipped when git-spice isn't installed, or isn't set up in the current repo.
# `gs ls` may still prune stale git-spice tracking data as a side effect.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

# Time
if [ -n "${SITREP_TZ:-}" ]; then
  local_time=$(TZ="$SITREP_TZ" date '+%a %b %d %I:%M %p %Z')
else
  local_time=$(date '+%a %b %d %I:%M %p %Z')
fi
utc=$(date -u '+%H:%M UTC')

# Git info
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "n/a")
sha=$(git rev-parse --short HEAD 2>/dev/null || echo "n/a")

# PR
pr_url=$(gh pr view --json url -q .url 2>/dev/null || true)

# Git status
git_status=$(git status --short 2>/dev/null || true)
if [ -z "$git_status" ]; then
  status_line="clean"
else
  changed=$(echo "$git_status" | wc -l | tr -d ' ')
  status_line="$changed changed files"
fi

# Branch stack
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  stack="(not in a git repo)"
elif ! command -v gs >/dev/null 2>&1; then
  stack="(git-spice not installed)"
elif ! git show-ref --verify --quiet refs/spice/data; then
  # `gs ls` sets git-spice up in a repo that doesn't use it yet, which writes
  # refs/spice/data. A report shouldn't change the repo, so skip it.
  stack="(git-spice not set up in this repo)"
else
  stack=$(gs ls 2>&1 || true)
fi

# Print
echo "SITREP — $local_time ($utc)"
echo ""
printf "Dir:      %s\n" "$PWD"
printf "Branch:   %s @ %s\n" "$branch" "$sha"
printf "PR:       %s\n" "${pr_url:-none}"
printf "Status:   %s\n" "$status_line"
echo ""
echo "Stack:"
echo "$stack" | sed 's/^/  /'

# Show dirty files if any
if [ -n "$git_status" ]; then
  echo ""
  echo "Changes:"
  echo "$git_status" | sed 's/^/  /'
fi
