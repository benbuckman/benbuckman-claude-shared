#!/usr/bin/env python3
"""
Reconstruct the `claude --resume` picker view by reading the JSONL session
files under ~/.claude/projects/ directly. Faster than capturing the picker
(no Claude CLI involved) and matches its output schema. Title is the latest
custom-title event in the file, falling back to the latest ai-title.

The transcript format is internal to Claude Code and changes between versions.
tests/test_list_claude_conversations.py records the version this was last
checked against, and its live check reads this machine's transcripts.

SPDX-License-Identifier: MIT
"""
import argparse
import json
import sys
import time
from pathlib import Path

DEFAULT_ROOT = Path.home() / ".claude" / "projects"


def human_size(num_bytes: int) -> str:
    if num_bytes >= 1_048_576:
        return f"{num_bytes / 1_048_576:.1f}MB"
    if num_bytes >= 1024:
        return f"{num_bytes / 1024:.1f}KB"
    return f"{num_bytes}B"


def human_ago(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''} ago"
    if seconds < 3600:
        m = seconds // 60
        return f"{m} minute{'s' if m != 1 else ''} ago"
    if seconds < 86400:
        h = seconds // 3600
        return f"{h} hour{'s' if h != 1 else ''} ago"
    d = seconds // 86400
    return f"{d} day{'s' if d != 1 else ''} ago"


def decode_cwd(dir_name: str) -> str:
    """Fallback decoder for project dir names that encode cwd by replacing
    '/' with '-'. Lossy on paths containing real dashes — only used when no
    event in the session carries an authoritative `cwd` field."""
    return dir_name.replace("-", "/")


def find_project_dirs(root: Path) -> list[Path]:
    """If `root` itself contains *.jsonl, treat it as a single project dir.
    Otherwise enumerate its immediate subdirs (skipping the 'memory' dir)."""
    if any(root.glob("*.jsonl")):
        return [root]
    return sorted(d for d in root.iterdir() if d.is_dir() and d.name != "memory")


# A "real" user message is one whose text content doesn't start with any of
# these noise prefixes. Sessions where every user message is noise (and there
# are no assistant turns) are typically dead-on-arrival — user opened Claude,
# tried a slash command, exited. We drop those by default.
NOISE_PREFIXES = (
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<command-name>",
    "<system-reminder>",
)


def _truncate_title(text: str | None, max_len: int = 100) -> str | None:
    """Collapse a multi-line user prompt to a single-line title.
    Used when neither custom-title nor ai-title is set."""
    if not text:
        return None
    one_line = " ".join(text.split())
    if len(one_line) > max_len:
        one_line = one_line[: max_len - 1].rstrip() + "…"
    return one_line or None


def _message_text(evt: dict) -> str:
    msg = evt.get("message") or {}
    content = msg.get("content", "") if isinstance(msg, dict) else ""
    if isinstance(content, list):
        content = " ".join(
            c.get("text", "") if isinstance(c, dict) else "" for c in content
        )
    return str(content).strip()


def scan_session(path: Path, sid: str) -> dict:
    """Walk every JSONL line. Returns metadata + raw fork signals.

    Three fork signals exist:
      1. Explicit fork: a system event with `forkedFrom.sessionId`.
         (Created via Ctrl-fork in the picker, or `--fork-session`.)
      2. Copied events: newer Claude Code versions write no `forkedFrom`.
         Instead, each event copied from another session keeps that
         session's id in a snake_case `session_id` field, while `sessionId`
         is rewritten to this session's id. Copied events come first in the
         file, oldest ancestor first, so the source of the LAST copied event
         is the immediate parent. (Seen on Claude Code 2.1.300: a session
         forked from a fork carries copies from both ancestors, grandparent
         first, then parent.)
         `session_id` is undocumented, and a foreign one is not proof of a
         copy: sessions with unrelated content can carry one too, possibly
         after /clear. So resolve_forks accepts this candidate only when the
         two sessions also share at least one event uuid.
      3. Compaction fork: a `compact_boundary` system event whose
         `logicalParentUuid` points to a *message* uuid in another session.
         The parent session id has to be resolved via a global uuid index;
         resolve_forks() does that after every session has been scanned.

    Explicitly-forked sessions duplicate their parent's events (with the
    same uuids) into their own jsonl AND rewrite each event's `sessionId`
    field to the child's id — verified empirically: in a fork file with
    982 inherited events, every one carries the fork's sessionId, not the
    parent's. So an in-session sessionId filter cannot tell a real event
    from a copy. resolve_forks() handles the dedup by counting occurrences
    across ALL sessions and only indexing uuids that appear in exactly one.
    Here we just collect every event's uuid and pass them along.
    """
    last_custom_title = None
    last_ai_title = None
    last_user_prompt = None
    last_branch = None
    last_pr = None
    first_cwd = None
    explicit_fork_parent = None  # forkedFrom.sessionId
    copied_from = None  # session_id of the last event copied from another session
    compact_parent_uuids: list[str] = (
        []
    )  # every compact_boundary.logicalParentUuid in order
    own_event_uuids: list[str] = []
    real_user_count = 0
    assistant_count = 0

    with path.open("rb") as f:
        for raw_line in f:
            try:
                evt = json.loads(raw_line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            t = evt.get("type")
            if t == "custom-title" and evt.get("customTitle"):
                last_custom_title = evt["customTitle"]
            elif t == "ai-title" and evt.get("aiTitle"):
                last_ai_title = evt["aiTitle"]
            elif t == "pr-link" and evt.get("prNumber"):
                last_pr = evt
            elif t == "last-prompt" and evt.get("lastPrompt"):
                last_user_prompt = evt["lastPrompt"]
            elif t == "user":
                text = _message_text(evt)
                if text and not text.startswith(NOISE_PREFIXES):
                    real_user_count += 1
            elif t == "assistant":
                assistant_count += 1
            br = evt.get("gitBranch")
            if br:
                last_branch = br
            cwd = evt.get("cwd")
            if cwd and first_cwd is None:
                # Sessions toggle their cwd as bash tools cd around; the
                # session's "home" cwd is where the user launched claude,
                # which is the first cwd we see in the event stream.
                first_cwd = cwd

            src = evt.get("session_id")
            if isinstance(src, str) and src and src != sid:
                copied_from = src

            ff = evt.get("forkedFrom")
            if isinstance(ff, dict) and ff.get("sessionId"):
                explicit_fork_parent = ff["sessionId"]
            if (
                t == "system"
                and evt.get("subtype") == "compact_boundary"
                and evt.get("logicalParentUuid")
            ):
                # A session can in principle have multiple compact_boundary
                # events (multiple compactions). Keep all of them; resolve_forks
                # walks the list and picks the first one that points outside
                # this session — a later in-session compaction shouldn't
                # shadow the original cross-session parent.
                compact_parent_uuids.append(evt["logicalParentUuid"])
            u = evt.get("uuid")
            if u:
                own_event_uuids.append(u)

    # Title fallback chain matches the /resume picker's behavior for the
    # cases we care about: a session like ee2e6ab8 whose only real prompt
    # was "hello" gets that as its title rather than "(untitled)".
    title = (
        last_custom_title
        or last_ai_title
        or _truncate_title(last_user_prompt)
        or "(untitled)"
    )
    pr_repo = last_pr.get("prRepository") if last_pr else None
    pr_num = last_pr.get("prNumber") if last_pr else None
    return {
        "title": title,
        "branch": last_branch,
        "cwd": first_cwd,
        "pr_repo": pr_repo,
        "pr_number": pr_num,
        "explicit_fork_parent": explicit_fork_parent,
        "copied_from": copied_from,
        "compact_parent_uuids": compact_parent_uuids,
        "own_event_uuids": own_event_uuids,
        "real_user_count": real_user_count,
        "assistant_count": assistant_count,
    }


def resolve_forks(raw_sessions: list) -> dict[str, str | None]:
    """Resolve each session's parent (forked_from_id) by id.

    Explicit forks come straight from `forkedFrom.sessionId` — no lookup
    needed. Next comes the source of the last copied event (see
    scan_session), when the two sessions share an event uuid. Compaction forks reference a parent message uuid that has to
    be resolved through a global uuid -> session_id index.

    Building that index is subtle because explicit forks duplicate their
    parent's events into their own jsonl (with rewritten sessionId — see
    scan_session). A naive uuid -> session map would have those duplicated
    uuids shadowing each other, and a compact-fork sibling could resolve
    to the wrong session.

    Defense: count how many sessions each uuid appears in. Only index
    uuids that appear in exactly ONE session — those are guaranteed
    not to be copies. Compact-fork resolutions for ambiguous uuids
    (present in multiple sessions) get left unresolved rather than
    risking a wrong attribution.
    """
    uuid_count: dict[str, int] = {}
    for _sid, _cwd, _path, _stat, data in raw_sessions:
        for u in data["own_event_uuids"]:
            uuid_count[u] = uuid_count.get(u, 0) + 1

    uuid_to_session: dict[str, str] = {}
    for sid, _cwd, _path, _stat, data in raw_sessions:
        for u in data["own_event_uuids"]:
            if uuid_count[u] == 1:
                uuid_to_session[u] = sid

    uuids_by_session: dict[str, set[str]] = {}
    wanted = {data["copied_from"] for *_rest, data in raw_sessions if data["copied_from"]}
    for sid, _cwd, _path, _stat, data in raw_sessions:
        if sid in wanted:
            uuids_by_session[sid] = set(data["own_event_uuids"])

    resolved: dict[str, str | None] = {}
    for sid, _cwd, _path, _stat, data in raw_sessions:
        parent = data["explicit_fork_parent"]
        candidate = data["copied_from"]
        if not parent and candidate and candidate in uuids_by_session:
            if uuids_by_session[candidate] & set(data["own_event_uuids"]):
                parent = candidate
        if not parent:
            for parent_uuid in data["compact_parent_uuids"]:
                candidate = uuid_to_session.get(parent_uuid)
                if candidate and candidate != sid:
                    parent = candidate
                    break
        resolved[sid] = parent
    return resolved


def collect(root: Path, now: float, include_empty: bool = False) -> list[dict]:
    raw_sessions = []  # (id, project_dir, path, stat, scan_data)
    for project_dir in find_project_dirs(root):
        fallback_cwd = decode_cwd(project_dir.name)
        for jsonl in project_dir.glob("*.jsonl"):
            try:
                stat = jsonl.stat()
            except OSError:
                continue
            sid = jsonl.stem
            data = scan_session(jsonl, sid)
            # Drop sessions that have no real exchange (all user messages are
            # slash-command noise and there are no assistant turns) AND have
            # no human-set or AI-set title. A titled session is presumed
            # intentional even if the JSONL looks empty by these metrics.
            if (
                not include_empty
                and data["real_user_count"] == 0
                and data["assistant_count"] == 0
                and data["title"] == "(untitled)"
            ):
                continue
            # Prefer cwd from any event (authoritative); fall back to the
            # lossy directory-name decode only when no event carried cwd.
            cwd = data["cwd"] or fallback_cwd
            raw_sessions.append((sid, cwd, str(jsonl), stat, data))

    forked_from = resolve_forks(raw_sessions)

    entries = []
    for sid, cwd, path, stat, data in raw_sessions:
        entries.append(
            {
                "id": sid,
                "project_dir": cwd,
                "title": data["title"],
                "ago": human_ago(now - stat.st_mtime),
                "mtime": int(stat.st_mtime),
                "branch": data["branch"],
                "size": human_size(stat.st_size),
                "size_bytes": stat.st_size,
                "pr_repo": data["pr_repo"],
                "pr_number": data["pr_number"],
                "forked_from_id": forked_from[sid],
                "path": path,
            }
        )
    # Stable, deterministic ordering: newest first, then by id to break
    # ties on mtime collisions (rare but possible — same-second writes,
    # mass archive operations, low-resolution mtimes).
    entries.sort(key=lambda e: (-e["mtime"], e["id"]))
    return entries


def format_pretty(entries: list[dict]) -> str:
    out = []
    for e in entries:
        meta = f"{e['ago']} · {e['branch'] or '?'} · {e['size']}"
        if e["pr_repo"] and e["pr_number"]:
            meta += f" · {e['pr_repo']}#{e['pr_number']}"
        block = f"  ❯ {e['title']}\n    {meta}\n    {e['project_dir']}"
        if e["forked_from_id"]:
            block += f"\n    ↳ forked from {e['forked_from_id']}"
        out.append(block + "\n")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "root",
        nargs="?",
        default=str(DEFAULT_ROOT),
        help=f"Project dir or root containing project dirs (default: {DEFAULT_ROOT})",
    )
    ap.add_argument(
        "--pretty",
        action="store_true",
        help="Human-readable output instead of JSON",
    )
    ap.add_argument(
        "--include-empty",
        action="store_true",
        help=(
            "Include sessions where every user message is slash-command "
            "noise AND there is no custom/AI title (skipped by default)."
        ),
    )
    args = ap.parse_args()

    root = Path(args.root).expanduser()
    if not root.exists():
        print(f"error: {root} does not exist", file=sys.stderr)
        return 1
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 1

    try:
        entries = collect(root, now=time.time(), include_empty=args.include_empty)
    except PermissionError as e:
        print(f"error: cannot read {root}: {e}", file=sys.stderr)
        return 1
    if args.pretty:
        sys.stdout.write(format_pretty(entries))
    else:
        public_fields = [
            "id",
            "project_dir",
            "title",
            "ago",
            "branch",
            "size",
            "pr_repo",
            "pr_number",
            "forked_from_id",
            "path",
        ]
        public = [{k: e[k] for k in public_fields} for e in entries]
        json.dump(public, sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
