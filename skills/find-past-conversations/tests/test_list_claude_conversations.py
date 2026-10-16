"""Smoke test for list-claude-conversations.py.

Run with: python3 -m unittest discover -s tests

The transcript format is internal to Claude Code and changes between versions.
The fixtures check the script's own rules. The live check lists this machine's
real transcripts, which is what catches a format change. When it fails after
a Claude Code update, fix the script, then update CHECKED_VERSION.

SPDX-License-Identifier: MIT
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

CHECKED_VERSION = "2.1.301"
CHECKED_DATE = "2026-10-16"

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "list-claude-conversations.py"
FIXTURES = HERE / "fixtures" / "projects"

PARENT = "11111111-1111-4111-8111-111111111111"
EXPLICIT = "22222222-2222-4222-8222-222222222222"
COPIED = "33333333-3333-4333-8333-333333333333"
UNRELATED = "44444444-4444-4444-8444-444444444444"
NOISE = "55555555-5555-4555-8555-555555555555"


def run(*args):
    out = subprocess.run(
        [sys.executable, "-I", str(SCRIPT), *args],
        capture_output=True, text=True, check=True,
    ).stdout
    return {e["id"]: e for e in json.loads(out)}


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.sessions = run(str(FIXTURES))

    def test_titles(self):
        self.assertEqual(self.sessions[PARENT]["title"], "Garden planning")
        self.assertEqual(self.sessions[EXPLICIT]["title"], "Shed plans",
                         "a custom title wins over the AI title")

    def test_cwd_comes_from_the_transcript(self):
        self.assertEqual(self.sessions[PARENT]["project_dir"], "/tmp/example-project")

    def test_explicit_fork(self):
        self.assertEqual(self.sessions[EXPLICIT]["forked_from_id"], PARENT)

    def test_fork_found_from_copied_events(self):
        self.assertEqual(self.sessions[COPIED]["forked_from_id"], PARENT)

    def test_foreign_session_id_without_shared_events_is_not_a_fork(self):
        self.assertIsNone(self.sessions[UNRELATED]["forked_from_id"])

    def test_parent_has_no_parent(self):
        self.assertIsNone(self.sessions[PARENT]["forked_from_id"])

    def test_noise_only_session_is_skipped_unless_asked(self):
        self.assertNotIn(NOISE, self.sessions)
        self.assertIn(NOISE, run(str(FIXTURES), "--include-empty"))


class Live(unittest.TestCase):
    def test_this_machines_transcripts_still_list(self):
        root = Path.home() / ".claude" / "projects"
        if not root.is_dir():
            self.skipTest("no ~/.claude/projects on this machine")
        try:
            version = subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.split()[0]
        except (OSError, IndexError):
            version = "unknown"
        context = f"Claude Code {version}. Last checked on {CHECKED_VERSION} ({CHECKED_DATE})."
        sessions = run()
        self.assertGreater(len(sessions), 0, f"no sessions listed. {context}")
        titled = [s for s in sessions.values() if s["title"] != "(untitled)"]
        self.assertGreater(len(titled), 0, f"no session has a title. {context}")
        with_cwd = [s for s in sessions.values() if s["project_dir"].startswith("/")]
        self.assertEqual(len(with_cwd), len(sessions), f"a session has no working directory. {context}")
        if version not in ("unknown", CHECKED_VERSION):
            print(f"\nClaude Code is {version}, last checked on {CHECKED_VERSION}. "
                  "The live check passed, so update CHECKED_VERSION.", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
