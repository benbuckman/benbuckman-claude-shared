"""Smoke test for claude-to-md.py.

Run with: python3 -m unittest discover -s tests

The transcript format is internal to Claude Code and changes between versions.
The fixture checks the script's own rules. The live check renders the newest
real transcript on this machine, which is what catches a format change. When it
fails after a Claude Code update, fix the script, then update CHECKED_VERSION.

SPDX-License-Identifier: MIT
"""

import re
import subprocess
import sys
import unittest
from pathlib import Path

CHECKED_VERSION = "2.1.301"
CHECKED_DATE = "2026-10-16"

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "claude-to-md.py"
FIXTURE = HERE / "fixtures" / "session.jsonl"


def run(*args):
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPT), *args],
        capture_output=True, text=True, check=True,
    ).stdout


def turn_headings(out):
    """The heading that opens each turn: the user's name, or the compaction-summary label."""
    return [line for line in out.split("\n") if re.fullmatch(r"#### .+:", line) and line != "#### Claude:"]


class Fixture(unittest.TestCase):
    def test_header(self):
        out = run(str(FIXTURE))
        self.assertRegex(out, r"(?m)^# Fixture session$", "custom title wins over the AI title")
        self.assertIn("**Session:** `session`", out)
        self.assertIn("**Directory:** `/tmp/example-project`", out)
        self.assertRegex(out, r"\*\*Dates:\*\* \d{4}-\d\d-\d\d \d\d:\d\d .* to \d{4}-\d\d-\d\d \d\d:\d\d")
        self.assertIn("*4 turns*", out)

    def test_noise_is_not_a_turn_and_thinking_is_never_shown(self):
        out = run(str(FIXTURE))
        self.assertEqual(len(turn_headings(out)), 4)
        for hidden in ("reminder noise", "background task finished", "Caveat noise", "private reasoning text"):
            self.assertNotIn(hidden, out)

    def test_compaction_summary_is_labeled(self):
        self.assertRegex(run(str(FIXTURE)), r"(?m)^#### Summary of the earlier conversation, written at compaction:$")

    def test_tool_calls_hidden_by_default_and_shown_on_request(self):
        self.assertNotIn("List files", run(str(FIXTURE)))
        out = run(str(FIXTURE), "--tool-calls", "yes")
        self.assertIn("`Bash`** — List files", out)
        self.assertRegex(out, r"(?m)^> a\.txt$")

    def test_turn_selection(self):
        self.assertEqual(len(turn_headings(run(str(FIXTURE), "--last", "1"))), 1)
        excluded = run(str(FIXTURE), "--exclude-last-turn")
        self.assertEqual(len(turn_headings(excluded)), 3)
        self.assertNotIn("Last answer", excluded)
        around = run(str(FIXTURE), "--around", "zebra", "--context", "0")
        self.assertEqual(len(turn_headings(around)), 1)
        self.assertIn("*Turn 3 of 4*", around)
        self.assertIn('around 1 that mention "zebra"', around)
        self.assertIn('No turns mention "no-such-text"', run(str(FIXTURE), "--around", "no-such-text"))

    def test_slack_converts_bold(self):
        out = run(str(FIXTURE), "--slack", "--last", "0")
        self.assertIn("*bold*", out)
        self.assertNotIn("**bold**", out)

    def test_unknown_flag_is_rejected(self):
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), str(FIXTURE), "--bogus"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Unknown flag: --bogus", r.stderr)


class Live(unittest.TestCase):
    def test_newest_transcript_still_renders(self):
        root = Path.home() / ".claude" / "projects"
        if not root.is_dir():
            self.skipTest("no ~/.claude/projects on this machine")
        transcripts = [p for d in root.iterdir() if d.is_dir() for p in d.glob("*.jsonl")]
        if not transcripts:
            self.skipTest("no transcripts found")
        newest = max(transcripts, key=lambda p: p.stat().st_mtime)
        try:
            version = subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.split()[0]
        except (OSError, IndexError):
            version = "unknown"
        context = f"Rendering {newest} with Claude Code {version}. Last checked on {CHECKED_VERSION} ({CHECKED_DATE})."
        out = run(str(newest), "--last", "3")
        self.assertGreaterEqual(len(turn_headings(out)), 1, f"no turns found. {context}")
        for tag in ("<system-reminder>", "<task-notification>", "<local-command-caveat>"):
            self.assertNotIn(tag, out, f"raw {tag} leaked into the output. {context}")
        if version not in ("unknown", CHECKED_VERSION):
            print(f"\nClaude Code is {version}, last checked on {CHECKED_VERSION}. "
                  "The live check passed, so update CHECKED_VERSION.", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
