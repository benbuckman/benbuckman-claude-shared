---
name: recap-last
description: Recap the last N turns of this session, one sentence per turn, then end with the session's topic, goal, and next step. Use when the user says "/recap-last", "recap the last N turns", or "what happened in the last few turns".
argument-hint: "[N, default 10]"
user-invocable: true
---

# Recap the last N turns

`$ARGUMENTS` is N, the number of turns. If it is empty or not a number, use 10.

1. Count back N turns from this request, not counting the request itself. A turn is one incoming message and your reply to it. Scheduled or automated prompts, such as a monitor check, count as turns.
2. Write a numbered list, oldest first, with one plain sentence per turn: what came in, and what you did or found. Name files, commits, and job ids where they matter.
3. End with a short summary of the whole session, including Topic (1-2 sentences), Goal (the session's overall goal, in one sentence), and Next (the next step, or the decision you are waiting on, in one sentence).

Change nothing while recapping: no edits, commits, or messages.
