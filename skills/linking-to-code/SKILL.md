---
name: linking-to-code
description: 'Format clickable, durable GitHub source links in prose — PR descriptions, issue-tracker tickets and comments, Slack messages, design docs, plain-text emails. Use when drafting any human-readable artifact that references code (a file, a line, a directory, a diff). MANDATORY TRIGGERS: "link to this code", "code link", "permalink to", "github URL for", "format a code reference", "gh-link". Also activates implicitly when another skill needs to embed code references in its output.'
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/gh-link *), Bash(git rev-parse *), Bash(git remote get-url *), Read
---
# Linking to code

When drafting prose that references code — a file, a line range, a directory, a diff — generate a clickable GitHub URL rather than naming the path bare. The bundled script, `${CLAUDE_SKILL_DIR}/scripts/gh-link`, produces these URLs. Its tests are in `tests/`, and run with `node --test` on Node 22.18 or later. This skill says **when** to link, **which ref** to pin to, **how** to invoke `gh-link`, and **how to format the result** for the destination surface.

## When to link

If you'd otherwise write a bare path or symbol name in prose, replace it with a clickable URL. Common surfaces:

- PR descriptions and inline PR comments
- Linear ticket bodies and comments
- Slack messages
- Design docs (Google Docs, repo Markdown)
- Plain-text emails

Skip the link in code comments (those are read alongside the code itself) and in plain commit-message bodies (where the reader is already in the git tree).

## Which mode to use

The choice splits cleanly on a single question: **is the reference's primary subject a change that happened (or is happening) in a specific PR?**

- **Yes** → `--mode=pr`. The PR's `/files` archive is the right artifact: it shows the diff context, lives forever even after squash-merge, and gives the reader the "what changed" framing the reference implies. Examples:
  - "This PR adds `scripts/foo`" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" --mode=pr --pr=<this PR> -R <owner>/<repo> scripts/foo`
  - "This PR changes `gh-link.test.ts:42`" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" --mode=pr --pr=<this PR> -R <owner>/<repo> tests/gh-link.test.ts:42`
  - "PR #123 made this change to `bar.ts`" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" --mode=pr --pr=123 -R <owner>/<repo> path/to/bar.ts`
  - "Line 42 of `baz.ts` as I modified it in PR #456" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" --mode=pr --pr=456 -R <owner>/<repo> path/to/baz.ts:42`

- **No** → `--mode=blob` (the default). The reference is about code as it currently exists, regardless of which PR introduced it. The originating PR isn't the point for the reader. Examples:
  - "This cronjob runs every Monday" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> scripts/weekly-cleanup.sh` (default blob, default branch)
  - "The `urlencode_path` helper handles spaces" → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" --commit=<sha> -R <owner>/<repo> packages/lib/url-utils.ts:165-185` (SHA-pinned to freeze the line range)
  - "Line 130 of `style-guide.md` says X" (and you're not making a point about a PR-specific change) → `"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> docs/style-guide.md` (blob at the default branch)

See "How to invoke" below for the full set of flags and shorthand details.

The full lookup:

| Situation | Tool | Why |
|---|---|---|
| **Anything inside a PR** (whole file, specific line, deleted hunk — yours or someone else's PR) | `--mode=pr --pr=<num> path[:N\|:LN\|:N-M\|:LN-LM]` | Anchors at the per-file diff card with optional line suffix. PR `/files` archive outlives the branch + squash-merge. |
| Specific line/range of code that pre-existed the current PR, where the originating PR isn't the point | `--commit=<sha> path:N-M` | Line numbers shift; SHA freezes the exact code. |
| File or directory generically on the default branch, no specific lines — "the `gh-link` script", "test fixtures under `tests/`" | default (the default branch) | Stable across edits; reader sees current state. |
| Whole file/dir on a long-lived non-PR branch (`release`, multi-PR feature branch) | `--branch=<name>` | Branch ref works while the branch exists; for branches that aren't about to be merged-and-deleted. |
| Diff between two arbitrary refs (not tied to a PR) | `--mode=compare <base>...<head>` | Diff view between refs. |
| Tagged release | `--branch=v1.2.3` | Tags occupy the URL ref slot identically to branches. |

> **Directory inside a PR**: GitHub doesn't expose a per-directory anchor in `/files` — the anchors are per-file. For "whole directory inside a PR," use `--mode=tree --commit=<sha>` against the PR's HEAD SHA, or list specific files individually via PR mode.

## How to invoke `gh-link`

**Always pass `-R <owner>/<repo>`** (e.g. `-R example-org/example-repo`). Don't rely on origin-derivation when drafting prose — be explicit about which repo the link targets, especially when the prose may land in a cross-repo channel like Slack or a multi-repo design doc.

```bash
# === Inside a PR (the common case for in-PR-self-reference) ===

# Whole file inside a PR — anchors at the per-file diff card in /files
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=pr --pr=123 path/to/file.ts

# Specific line in a PR (bare digits default to R = right side / current state)
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=pr --pr=123 path/to/file.ts:42

# Line range in a PR
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=pr --pr=123 path/to/file.ts:42-50

# Deleted hunk in a PR — explicit L = left side (old/deleted)
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=pr --pr=123 path/to/file.ts:L42-L50

# === Code that exists outside a PR context ===

# File on the default branch (generic reference, no specific line)
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> path/to/file.ts

# Specific line range that must survive future edits → SHA
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --commit=<sha> path/to/file.ts:42-50

# Column range within a line (rare but supported; blob mode only)
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --commit=<sha> 'path/to/file.ts#L42C5-L42C20'

# Whole file on another branch
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --branch=my-feature path/to/file.ts

# Directory on the default branch
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=tree path/to/dir

# Diff between two refs
"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> --mode=compare main...feature-x
```

Default ref is the repo's default branch: `$GH_LINK_DEFAULT_REF` if set, else the branch the local clone's `origin/HEAD` names, else `HEAD`, which GitHub resolves to the default branch. Default mode is `blob`. `?plain=1` is auto-appended whenever a line/column fragment is present (required for `.md`, `.ipynb`, `.svg`, `.csv` files to render in source view where the line anchor works).

To get the current branch's HEAD SHA for an in-PR self-reference:

```bash
git rev-parse HEAD
```

## Format per surface

The same URL needs different framing depending on where the prose lives.

### Markdown — GitHub (PR descriptions, PR/issue comments) AND Linear (ticket bodies, comments)

| Reference count | Format |
|---|---|
| Single reference to a URL | Inline `[text](url)` |
| Repeated reference (same URL twice or more in one artifact) | **Reference-style `[text][label]`** with the definition at the bottom |

Example of reference-style:

```markdown
The [path resolution logic][p] handles three input shapes. The [same logic][p] applies to `tree` mode.

[p]: https://github.com/example-org/example-repo/blob/main/scripts/gh-link?plain=1#L195-L230
```

**Do NOT use footnote syntax (`[^label]`) in Linear** — Linear's Markdown parser doesn't recognize it; the `^label` shows up as literal text. Footnote works on GitHub, but reference-style works on both, so reference-style is the safe cross-surface choice.

### Slack

Slack uses its own format: `<url|label>`. Slack auto-unfurls bare URLs into previews, which is sometimes desirable (when the link IS the payload) and sometimes noisy (when it's inline in prose).

```
The path resolution (<https://github.com/example-org/example-repo/blob/main/scripts/gh-link?plain=1#L195-L230|gh-link:195-230>) handles three input shapes.
```

For threaded discussion where the link is the headline, a bare URL with auto-unfurl is fine. For inline-prose references, the labeled form keeps the message readable.

### Plain text — emails, terminals, anywhere without Markdown rendering

Two acceptable patterns:

- Descriptor with URL in parens: `the path resolution (https://github.com/example-org/example-repo/blob/main/scripts/gh-link?plain=1#L195-L230) handles three input shapes`
- Bare URL on its own: `Path resolution: https://github.com/example-org/example-repo/blob/main/scripts/gh-link?plain=1#L195-L230`

## Recap

1. **When**: any prose that names a path or symbol.
2. **Which mode**: if the reference is about something that happened in a PR (yours or someone else's, any line range or whole file or deleted hunk), use `--mode=pr --pr=<num>`. Otherwise: `--commit=<sha>` for specific lines that must survive future edits; the default branch for generic file/dir refs; `--branch=<name>` for long-lived non-PR branches; `--mode=compare` for non-PR diffs.
3. **How**: `"${CLAUDE_SKILL_DIR}/scripts/gh-link" -R <owner>/<repo> ...` — always `-R`.
4. **Format**: inline `[text](url)` for one ref; reference-style `[text][label]` for repeats. Slack uses `<url|label>`. Footnote works on GitHub but not Linear; prefer reference-style for portability.
