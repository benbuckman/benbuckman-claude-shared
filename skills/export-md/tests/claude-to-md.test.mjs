// Smoke test for claude-to-md.mjs. Run with: node --test tests/claude-to-md.test.mjs
//
// The transcript format is internal to Claude Code and changes between
// versions. The fixture checks the script's own rules. The live check renders
// the newest real transcript on this machine, which is what catches a format
// change. When it fails after a Claude Code update, fix the script, then
// update CHECKED_VERSION.
//
// SPDX-License-Identifier: MIT

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, statSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const CHECKED_VERSION = '2.1.300';
const CHECKED_DATE = '2026-10-15';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'claude-to-md.mjs');
const fixture = join(here, 'fixtures', 'session.jsonl');

const run = (...args) => execFileSync('node', [script, ...args], {encoding: 'utf8'});
// The heading that opens each turn: the user's name, or the compaction-summary label.
const turnHeadings = (out) => out.split('\n').filter((l) => /^#### .+:$/.test(l) && l !== '#### Claude:');

test('header shows the title, session, directory, and dates', () => {
  const out = run(fixture);
  assert.match(out, /^# Fixture session$/m, 'custom title wins over the AI title');
  assert.match(out, /\*\*Session:\*\* `session`/);
  assert.match(out, /\*\*Directory:\*\* `\/tmp\/example-project`/);
  assert.match(out, /\*\*Dates:\*\* .+ to .+/);
  assert.match(out, /\*4 turns\*/);
});

test('noise is not a turn, and thinking is never shown', () => {
  const out = run(fixture);
  assert.equal(turnHeadings(out).length, 4);
  for (const hidden of ['reminder noise', 'background task finished', 'Caveat noise', 'private reasoning text']) {
    assert.ok(!out.includes(hidden), `should not include "${hidden}"`);
  }
});

test('a compaction summary is labeled as a summary', () => {
  const out = run(fixture);
  assert.match(out, /^#### Summary of the earlier conversation, written at compaction:$/m);
});

test('tool calls are hidden by default and shown with --tool-calls yes', () => {
  assert.ok(!run(fixture).includes('List files'), 'tool calls hidden by default');
  const out = run(fixture, '--tool-calls', 'yes');
  assert.match(out, /`Bash`\*\* — List files/);
  assert.match(out, /> a\.txt/);
});

test('--last, --exclude-last-turn, and --around select turns', () => {
  assert.equal(turnHeadings(run(fixture, '--last', '1')).length, 1);
  const excluded = run(fixture, '--exclude-last-turn');
  assert.equal(turnHeadings(excluded).length, 3);
  assert.ok(!excluded.includes('Last answer'));
  const around = run(fixture, '--around', 'zebra', '--context', '0');
  assert.equal(turnHeadings(around).length, 1);
  assert.match(around, /\*Turn 3 of 4\*/);
  assert.match(around, /around 1 that mention "zebra"/);
  assert.match(run(fixture, '--around', 'no-such-text'), /No turns mention "no-such-text"/);
});

test('--slack converts Markdown bold to Slack bold', () => {
  const out = run(fixture, '--slack', '--last', '0');
  assert.ok(out.includes('*bold*') && !out.includes('**bold**'));
});

test('live: the newest transcript on this machine still renders', (t) => {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return t.skip('no ~/.claude/projects on this machine');
  let newest = null;
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(full, name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = {path, mtime};
    }
  }
  if (!newest) return t.skip('no transcripts found');
  let version = 'unknown';
  try { version = execFileSync('claude', ['--version'], {encoding: 'utf8'}).trim().split(' ')[0]; } catch {}
  const out = run(newest.path, '--last', '3');
  const context = `Rendering ${newest.path} with Claude Code ${version}. Last checked on ${CHECKED_VERSION} (${CHECKED_DATE}).`;
  assert.ok(turnHeadings(out).length >= 1, `no turns found. ${context}`);
  for (const tag of ['<system-reminder>', '<task-notification>', '<local-command-caveat>']) {
    assert.ok(!out.includes(tag), `raw ${tag} leaked into the output. ${context}`);
  }
  if (version !== 'unknown' && version !== CHECKED_VERSION) {
    t.diagnostic(`Claude Code is ${version}, last checked on ${CHECKED_VERSION}. The live check passed, so update CHECKED_VERSION.`);
  }
});
