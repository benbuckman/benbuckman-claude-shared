---
name: sitrep
description: Situation report — time, git state, PR, branch stack, tasks, sub-agents, and what this session is working on.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/sitrep.sh*), TaskList
---

1. Run `${CLAUDE_SKILL_DIR}/sitrep.sh` and print its output verbatim in a code block.

2. Append these two sections (from your own internal state):

```
Tasks:    <current task list, or "none">
Agents:   <running sub-agents, or "none">
```

3. Remind me what we're discussing / working on in this conversation, and what work you've done so far.

This is the long form of the one-line status footer that `claude--working-with-code.md` asks for at the end of each turn.
