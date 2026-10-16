#!/usr/bin/env python3
"""Convert a Claude Code conversation transcript (JSONL) to Markdown.

Usage:
  claude-to-md.py <session-file.jsonl> [--last N | --around TEXT [--context N]]
                  [--exclude-last-turn] [--blockquote] [--slack]
                  [--tool-calls yes|no]

Options:
  --last N             Only show the last N back-and-forths (default: 10).
                       0 shows all of them.
  --around TEXT        Instead of the last N, show the back-and-forths whose
                       text contains TEXT (ignoring case), each with its
                       neighbors. Turns are numbered, and "…" marks a gap.
  --context N          With --around, how many neighboring turns to show on
                       each side of a match (default: 1)
  --exclude-last-turn  Drop the final turn. Use when exporting the session you
                       are currently inside, so the "export this conversation"
                       request itself doesn't appear in its own export.
  --blockquote         Prefix every output line with "> " (for pasting into Markdown)
  --slack              Format output for Slack (mrkdwn) instead of Markdown
  --tool-calls         Show tool call details: yes or no (default: no)

A "back-and-forth" is a user message followed by the full assistant response
(which may span multiple JSONL records: text, tool_use, tool_result, etc).

The transcript format is internal to Claude Code and changes between versions.
tests/test_claude_to_md.py records the version this was last checked against,
and its live check reads a real transcript on this machine.

Ported from an earlier JavaScript version, claude-to-md.mjs.

SPDX-License-Identifier: MIT
"""

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def js_parse_int(value):
    """Mimic JavaScript's parseInt: the leading integer, or None for NaN."""
    m = re.match(r"\s*([+-]?\d+)", value)
    return int(m.group(1)) if m else None


def js_length(text):
    """String length in UTF-16 code units, as JavaScript counts it."""
    return len(text.encode("utf-16-le")) // 2


def js_slice(text, n):
    """The first n UTF-16 code units of text, as JavaScript's slice(0, n)."""
    return text.encode("utf-16-le")[: 2 * n].decode("utf-16-le", errors="replace")


# --- Get the user's first name from gitconfig ---
user_name = "User"
try:
    out = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True, check=True).stdout
    if out.strip():
        user_name = out.strip().split()[0]
except (OSError, subprocess.CalledProcessError):
    pass  # fall back to 'User'

# --- Parse args ---
args = sys.argv[1:]
file_path = None
last_n = 10
exclude_last_turn = False
blockquote = False
slack = False
show_tool_calls = False
around_text = None
context_n = 1

i = 0
while i < len(args):
    a = args[i]
    nxt = args[i + 1] if i + 1 < len(args) else None
    if a == "--last" and nxt:
        last_n = js_parse_int(nxt)
        i += 1
    elif a == "--around" and nxt is not None:
        around_text = nxt
        i += 1
    elif a == "--context" and nxt:
        context_n = js_parse_int(nxt)
        i += 1
    elif a == "--exclude-last-turn":
        exclude_last_turn = True
    elif a == "--blockquote":
        blockquote = True
    elif a == "--slack":
        slack = True
    elif a.startswith("--tool-calls"):
        val = a.split("=")[1] if "=" in a else nxt
        show_tool_calls = val == "yes"
        if "=" not in a:
            i += 1
    elif not a.startswith("-"):
        file_path = a
    else:
        # Without this, an unrecognized flag is skipped and its VALUE (which doesn't
        # start with "-") lands in file_path instead — e.g. a stale `--marker <uuid>`
        # call silently reads the uuid as the input file and dies.
        print(f"Unknown flag: {a}", file=sys.stderr)
        sys.exit(1)
    i += 1

# A NaN from parseInt behaves as 0: "show everything" for --last, no neighbors for --context.
last_n = last_n or 0
context_n = context_n or 0


# --- Slack vs Markdown formatting helpers ---
def bold(t):
    return f"*{t}*" if slack else f"**{t}**"


def italic(t):
    return f"_{t}_" if slack else f"*{t}*"


def heading(level, t):
    return f"*{t}*" if slack else f"{'#' * level} {t}"


def hr():
    return "———" if slack else "---"


def code(t):
    """Inline code — same syntax in both formats."""
    return "`" + t + "`"


def bq(t):
    """Blockquote line prefix."""
    return f"> {t}"


if not file_path:
    print("Usage: claude-to-md.py <session-file.jsonl> [--last N]", file=sys.stderr)
    sys.exit(1)

# --- Read and parse JSONL ---
raw = Path(file_path).read_text(encoding="utf-8")
records = [json.loads(line) for line in raw.split("\n") if line]

# --- Filter to user/assistant messages ---
messages = [r for r in records if r.get("type") in ("user", "assistant")]

# --- Session details for the header ---
# The title is the latest custom title, falling back to the latest AI title,
# the same order the `claude --resume` picker uses.
name = Path(file_path).name
session_id = name[: -len(".jsonl")] if name.endswith(".jsonl") and name != ".jsonl" else name
custom_title = None
ai_title = None
for r in records:
    if r.get("type") == "custom-title" and r.get("customTitle"):
        custom_title = r["customTitle"]
    if r.get("type") == "ai-title" and r.get("aiTitle"):
        ai_title = r["aiTitle"]
session_title = custom_title or ai_title
session_cwd = next((r["cwd"] for r in records if r.get("cwd")), None)
timestamps = sorted(r["timestamp"] for r in records if r.get("timestamp"))
first_timestamp = timestamps[0] if timestamps else None
last_timestamp = timestamps[-1] if timestamps else None


# --- Group into back-and-forths ---
# A back-and-forth starts with a user message (that isn't a tool_result or system noise)
# and includes all subsequent assistant records until the next user message.
NOISE_PREFIXES = (
    "<local-command-caveat>",
    "<command-name>",
    "<local-command-stdout>",
    "<system-reminder>",
    # A finished subagent or background task is reported to the session as a
    # user-role message. It belongs to the assistant turn it arrived in.
    "<task-notification>",
)


def is_real_user_message(record):
    if record.get("type") != "user":
        return False
    if record.get("isMeta"):
        return False
    content = (record.get("message") or {}).get("content")
    # Tool results are part of the assistant's turn, not a new user message
    if isinstance(content, list):
        return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    if isinstance(content, str):
        return not content.startswith(NOISE_PREFIXES)
    return False


def strip_system_tags(text):
    """Remove <system-reminder>...</system-reminder> blocks."""
    return re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", "", text).strip()


def extract_user_text(record):
    """Extract the user-visible text from a user message, stripping system tags."""
    content = (record.get("message") or {}).get("content")
    if isinstance(content, str):
        return strip_system_tags(content)
    if isinstance(content, list):
        return "\n".join(strip_system_tags(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def convert_markdown_to_slack(text):
    """Convert Markdown text to Slack mrkdwn format.

    Handles bold, italic, strikethrough, headers, links, and tables. Code blocks
    and inline code use the same syntax in both formats.
    """
    # Split into code-block vs non-code segments to avoid mangling code
    segments = re.split(r"(```[\s\S]*?```)", text)
    out = []
    for segment in segments:
        # Don't touch code blocks
        if segment.startswith("```"):
            # Strip language hint (Slack ignores it)
            out.append(re.sub(r"^```\w*\n", "```\n", segment, count=1))
            continue

        result = segment

        # --- Bold vs italic conversion ---
        # Markdown **bold** must become Slack *bold*, but Markdown *italic* must
        # become Slack _italic_. Converting **bold** to *bold* first would let the
        # italic pass re-match it as _bold_. So bold conversions write a sentinel
        # the italic regex won't match, and a final pass swaps in Slack's *.
        BOLD = "__SLACKBOLD__"

        # Headers → bold
        result = re.sub(r"^#{1,6}\s+(.+)$", lambda m: BOLD + m.group(1) + BOLD, result, flags=re.M)

        # Markdown tables → plain text columns
        # Remove separator rows like |---|---|
        result = re.sub(r"^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$", "", result, flags=re.M)
        # Convert table rows: | a | b | c | → a  |  b  |  c
        result = re.sub(
            r"^\|(.+)\|?\s*$",
            lambda m: "  |  ".join(c.strip() for c in m.group(1).split("|") if c.strip()),
            result,
            flags=re.M,
        )

        # Bold+italic ***text*** or ___text___ → bold in Slack
        result = re.sub(r"\*{3}([^*]+)\*{3}", lambda m: BOLD + m.group(1) + BOLD, result)
        result = re.sub(r"_{3}([^_]+)_{3}", lambda m: BOLD + m.group(1) + BOLD, result)

        # Bold **text** → sentinel (not * yet, to avoid italic re-match)
        result = re.sub(r"\*\*([^*]+)\*\*", lambda m: BOLD + m.group(1) + BOLD, result)

        # Italic *text* → _text_ (safe now — sentinels don't contain *)
        result = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", lambda m: "_" + m.group(1) + "_", result)

        # Final pass: replace all bold sentinels with Slack bold marker (*)
        result = result.replace(BOLD, "*")

        # Strikethrough ~~text~~ → ~text~
        result = re.sub(r"~~([^~]+)~~", lambda m: "~" + m.group(1) + "~", result)

        # Links [title](url) → <url|title>
        result = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m: "<" + m.group(2) + "|" + m.group(1) + ">", result)

        # Horizontal rules --- or *** or ___ → ———
        result = re.sub(r"^[-*_]{3,}\s*$", "———", result, flags=re.M)

        out.append(result)
    return "".join(out)


turns = []
current_turn = None
for msg in messages:
    if is_real_user_message(msg):
        # Start a new turn
        if current_turn:
            turns.append(current_turn)
        current_turn = {"user": msg, "assistant": []}
    elif current_turn and msg.get("type") == "assistant":
        current_turn["assistant"].append(msg)
    # user tool_results are part of the current assistant turn, skip them
if current_turn:
    turns.append(current_turn)

# --- Drop the export turn itself ---
# When a session exports itself, the "export this conversation" request is already
# written to the JSONL as the final turn. Dropping it keeps --last N meaning "the N
# turns before I asked". A caller rendering a *finished* or past session omits the
# flag, since its final turn is real content.
filtered_turns = turns[:-1] if exclude_last_turn else turns


def turn_text(turn):
    """All the text of a turn, for --around matching."""
    parts = [extract_user_text(turn["user"])]
    for record in turn["assistant"]:
        content = (record.get("message") or {}).get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return "\n".join(parts).lower()


# Select turns: around a match, or the last N. Each entry keeps the turn's
# 1-based number in the whole session, so --around can label it.
match_count = 0
if around_text is not None:
    needle = around_text.lower()
    keep = set()
    for i, turn in enumerate(filtered_turns):
        if needle in turn_text(turn):
            match_count += 1
            for j in range(max(0, i - context_n), min(len(filtered_turns) - 1, i + context_n) + 1):
                keep.add(j)
    selected_turns = [(filtered_turns[i], i + 1) for i in sorted(keep)]
else:
    start = max(0, len(filtered_turns) - last_n) if last_n else 0
    selected_turns = [(turn, start + k + 1) for k, turn in enumerate(filtered_turns[start:])]


# --- Render to Markdown ---
def find_tool_result(tool_use_id):
    """Find a tool_result matching a tool_use_id across all records."""
    for record in records:
        if record.get("type") != "user":
            continue
        content = (record.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") == tool_use_id:
                return block
    return None


def js_json(value, indent=None):
    """JSON text as JavaScript's JSON.stringify writes it."""
    if indent is None:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(value, ensure_ascii=False, indent=indent)


def render_tool_use(block):
    """Render a tool_use block, and find its matching tool_result."""
    name = block.get("name")
    tool_input = block.get("input") or {}
    result = find_tool_result(block.get("id"))
    lines = []
    description = tool_input.get("description") or ""

    def tool_label(tool_name, suffix=""):
        return bq(f"{bold(code(str(tool_name)))}{suffix or ''}")

    if name == "Bash":
        cmd = tool_input.get("command") or ""
        lines.append(tool_label("Bash", f" — {description}" if description else ""))
        lines.append(bq("```") if slack else bq("```bash"))
        lines.append(bq(cmd))
        lines.append(bq("```"))
    elif name in ("Read", "Write", "Edit"):
        lines.append(tool_label(name, f" {tool_input.get('file_path') or ''}"))
    elif name in ("Glob", "Grep"):
        lines.append(tool_label(name, f" {code(tool_input.get('pattern') or '')}"))
    else:
        lines.append(tool_label(name))
        if tool_input:
            lines.append(bq("```") if slack else bq("```json"))
            lines.append(bq(js_json(tool_input, indent=2).replace("\n", "\n> ")))
            lines.append(bq("```"))

    # Render the result (truncated)
    if result:
        content = result.get("content")
        content = content if isinstance(content, str) else js_json(content)
        max_len = 500
        truncated = js_slice(content, max_len) + "\n…(truncated)" if js_length(content) > max_len else content
        error_prefix = bq(bold("Error:")) + "\n" if result.get("is_error") else ""
        lines.append(bq(""))
        lines.append(f"{error_prefix}{bq('```')}")
        for output_line in truncated.split("\n"):
            lines.append(bq(output_line))
        lines.append(bq("```"))

    return "\n".join(lines)


def render_turn(turn):
    lines = []

    # User message. A compaction summary is stored as a user message, but the
    # user didn't write it, so label it as what it is.
    user_text = extract_user_text(turn["user"])
    user_label = "Summary of the earlier conversation, written at compaction:" if turn["user"].get("isCompactSummary") else f"{user_name}:"
    lines.append(heading(4, user_label) + "\n")
    lines.append(convert_markdown_to_slack(user_text) if slack else user_text)
    lines.append("")

    # Assistant response
    lines.append(heading(4, "Claude:") + "\n")
    for record in turn["assistant"]:
        content = (record.get("message") or {}).get("content")
        if content is None or content == "":
            continue
        if isinstance(content, str):
            lines.append(convert_markdown_to_slack(content) if slack else content)
            lines.append("")
            continue
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "text":
                    text = (block.get("text") or "").strip()
                    lines.append(convert_markdown_to_slack(text) if slack else text)
                    lines.append("")
                elif kind == "tool_use" and show_tool_calls:
                    lines.append(render_tool_use(block))
                    lines.append("")
                # thinking blocks are internal, and always skipped

    return "\n".join(lines)


# --- Output ---
def local_time(iso):
    """A timestamp in this machine's time zone, in one fixed format."""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    except ValueError:
        return iso


header = [heading(1, session_title or "Claude Code Conversation") + "\n"]
header.append(f"{bold('Session:')} {code(session_id)}")
if session_cwd:
    header.append(f"{bold('Directory:')} {code(session_cwd)}")
if first_timestamp:
    header.append(f"{bold('Dates:')} {local_time(first_timestamp)} to {local_time(last_timestamp)}")
header.append(f"{bold('Exported:')} {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z')}")
header.append("")
if around_text is not None:
    header.append(italic(f'{len(selected_turns)} of {len(filtered_turns)} turns, around {match_count} that mention "{around_text}"') + "\n")
elif last_n and last_n < len(filtered_turns):
    header.append(italic(f"showing last {last_n} of {len(filtered_turns)} turns") + "\n")
else:
    header.append(italic(f"{len(filtered_turns)} turns") + "\n")
header.append(hr() + "\n")

body = []
previous_number = None
for turn, number in selected_turns:
    if around_text is not None:
        if previous_number is not None and number > previous_number + 1:
            body.append("…\n")
        body.append(italic(f"Turn {number} of {len(filtered_turns)}") + "\n")
    body.append(render_turn(turn))
    body.append(hr() + "\n")
    previous_number = number
if around_text is not None and match_count == 0:
    body.append(italic(f'No turns mention "{around_text}".') + "\n")

body_output = "\n".join(body)
if blockquote:
    body_output = "\n".join("> " + line for line in body_output.split("\n"))

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stdout.write("\n".join(header) + "\n" + body_output)
