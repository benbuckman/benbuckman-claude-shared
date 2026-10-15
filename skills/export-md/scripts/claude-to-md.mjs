#!/usr/bin/env node

/**
 * Convert Claude Code conversation JSONL to markdown.
 *
 * Usage:
 *   claude-to-md.mjs <session-file.jsonl> [--last N | --around TEXT [--context N]]
 *                    [--exclude-last-turn] [--blockquote] [--slack]
 *                    [--tool-calls yes|no]
 *
 * Options:
 *   --last N             Only show the last N back-and-forths (default: 10).
 *                        0 shows all of them.
 *   --around TEXT        Instead of the last N, show the back-and-forths whose
 *                        text contains TEXT (ignoring case), each with its
 *                        neighbors. Turns are numbered, and "…" marks a gap.
 *   --context N          With --around, how many neighboring turns to show on
 *                        each side of a match (default: 1)
 *   --exclude-last-turn  Drop the final turn. Use when exporting the session you
 *                        are currently inside, so the "export this conversation"
 *                        request itself doesn't appear in its own export.
 *   --blockquote         Prefix every output line with "> " (for pasting into markdown)
 *   --slack              Format output for Slack (mrkdwn) instead of Markdown
 *   --tool-calls         Show tool call details: yes or no (default: no)
 *
 * A "back-and-forth" is a user message followed by the full assistant response
 * (which may span multiple JSONL records: text, tool_use, tool_result, etc).
 *
 * The transcript format is internal to Claude Code and changes between
 * versions. tests/claude-to-md.test.mjs records the version this was last
 * checked against, and its live check reads a real transcript on this machine.
 *
 * SPDX-License-Identifier: MIT
 */

import {readFileSync} from 'fs';
import {execSync} from 'child_process';
import {basename} from 'path';

// --- Get user's first name from gitconfig ---
let userName = 'User';
try {
  userName = execSync('git config user.name', {encoding: 'utf8'}).trim().split(/\s+/)[0];
} catch {
  // fall back to 'User'
}

// --- Parse args ---

const args = process.argv.slice(2);
let filePath = null;
let lastN = 10;
let excludeLastTurn = false;
let blockquote = false;
let slack = false;
let showToolCalls = false;
let aroundText = null;
let contextN = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--last' && args[i + 1]) {
    lastN = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--around' && args[i + 1] !== undefined) {
    aroundText = args[i + 1];
    i++;
  } else if (args[i] === '--context' && args[i + 1]) {
    contextN = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--exclude-last-turn') {
    excludeLastTurn = true;
  } else if (args[i] === '--blockquote') {
    blockquote = true;
  } else if (args[i] === '--slack') {
    slack = true;
  } else if (args[i].startsWith('--tool-calls')) {
    const val = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
    showToolCalls = val === 'yes';
    if (!args[i].includes('=')) i++;
  } else if (!args[i].startsWith('-')) {
    filePath = args[i];
  } else {
    // Without this, an unrecognized flag is skipped and its VALUE (which doesn't
    // start with "-") lands in filePath instead — e.g. a stale `--marker <uuid>`
    // call silently reads the uuid as the input file and dies on ENOENT.
    console.error(`Unknown flag: ${args[i]}`);
    process.exit(1);
  }
}

// --- Slack vs Markdown formatting helpers ---

const fmt = {
  bold: (t) => slack ? `*${t}*` : `**${t}**`,
  italic: (t) => slack ? `_${t}_` : `*${t}*`,
  heading: (level, t) => slack ? `*${t}*` : `${'#'.repeat(level)} ${t}`,
  hr: () => slack ? '———' : '---',
  /** Inline code — same syntax in both formats */
  code: (t) => '`' + t + '`',
  /** Blockquote line prefix */
  bq: (t) => `> ${t}`,
};

if (!filePath) {
  console.error('Usage: claude-to-md.mjs <session-file.jsonl> [--last N]');
  process.exit(1);
}

// --- Read and parse JSONL ---

const raw = readFileSync(filePath, 'utf8');
const records = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// --- Filter to user/assistant messages ---

const messages = records.filter((r) => r.type === 'user' || r.type === 'assistant');

// --- Session details for the header ---
// The title is the latest custom title, falling back to the latest AI title,
// the same order the `claude --resume` picker uses.

const sessionId = basename(filePath, '.jsonl');
let customTitle = null;
let aiTitle = null;
for (const r of records) {
  if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
  if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
}
const sessionTitle = customTitle || aiTitle;
const sessionCwd = records.find((r) => r.cwd)?.cwd || null;
const timestamps = records.map((r) => r.timestamp).filter(Boolean).sort();
const firstTimestamp = timestamps[0] || null;
const lastTimestamp = timestamps[timestamps.length - 1] || null;

// --- Group into back-and-forths ---
// A back-and-forth starts with a user message (that isn't a tool_result or system noise)
// and includes all subsequent assistant records until the next user message.

/** @returns {boolean} */
function isRealUserMessage(record) {
  if (record.type !== 'user') return false;
  if (record.isMeta) return false;

  const content = record.message?.content;

  // Tool results are part of the assistant's turn, not a new user message
  if (Array.isArray(content)) {
    return !content.some((b) => b.type === 'tool_result');
  }

  if (typeof content === 'string') {
    // Skip system-injected messages
    if (content.startsWith('<local-command-caveat>')) return false;
    if (content.startsWith('<command-name>')) return false;
    if (content.startsWith('<local-command-stdout>')) return false;
    if (content.startsWith('<system-reminder>')) return false;
    // A finished subagent or background task is reported to the session as a
    // user-role message. It belongs to the assistant turn it arrived in.
    if (content.startsWith('<task-notification>')) return false;
    return true;
  }

  return false;
}

/** Extract the user-visible text from a user message, stripping system tags. */
function extractUserText(record) {
  const content = record.message?.content;
  if (typeof content === 'string') {
    return stripSystemTags(content);
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text')
      .map((b) => stripSystemTags(b.text))
      .join('\n');
  }
  return '';
}

function stripSystemTags(text) {
  // Remove <system-reminder>...</system-reminder> blocks
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Convert Markdown text to Slack mrkdwn format.
 * Handles bold, italic, strikethrough, headers, links, and tables.
 * Code blocks and inline code use the same syntax in both formats.
 */
function convertMarkdownToSlack(text) {
  // Split into code-block vs non-code segments to avoid mangling code
  const segments = text.split(/(```[\s\S]*?```)/g);

  return segments.map((segment) => {
    // Don't touch code blocks
    if (segment.startsWith('```')) {
      // Strip language hint (Slack ignores it)
      return segment.replace(/^```\w*\n/, '```\n');
    }

    let result = segment;

    // --- Bold vs italic conversion ---
    // Problem: Markdown **bold** must become Slack *bold*, but Markdown *italic*
    // must become Slack _italic_. If we convert **bold** → *bold* first, the
    // italic pass immediately re-matches it → _bold_ (wrong).
    // Solution: bold conversions write a temporary sentinel (__SLACKBOLD__) that
    // the italic regex won't match, then a final pass replaces all sentinels
    // with the real Slack bold marker (*).
    const BOLD = '__SLACKBOLD__';

    // Headers → bold
    result = result.replace(/^#{1,6}\s+(.+)$/gm, `${BOLD}$1${BOLD}`);

    // Markdown tables → plain text columns
    // Remove separator rows like |---|---|
    result = result.replace(/^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/gm, '');
    // Convert table rows: | a | b | c | → a  |  b  |  c
    result = result.replace(/^\|(.+)\|?\s*$/gm, (_match, inner) => {
      return inner.split('|').map(cell => cell.trim()).filter(Boolean).join('  |  ');
    });

    // Bold+italic ***text*** or ___text___ → bold in Slack
    result = result.replace(/\*{3}([^*]+)\*{3}/g, `${BOLD}$1${BOLD}`);
    result = result.replace(/_{3}([^_]+)_{3}/g, `${BOLD}$1${BOLD}`);

    // Bold **text** → sentinel (not * yet, to avoid italic re-match)
    result = result.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${BOLD}`);

    // Italic *text* → _text_ (safe now — sentinels don't contain *)
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_');

    // Final pass: replace all bold sentinels with Slack bold marker (*)
    result = result.replaceAll(BOLD, '*');

    // Strikethrough ~~text~~ → ~text~
    result = result.replace(/~~([^~]+)~~/g, '~$1~');

    // Links [title](url) → <url|title>
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    // Horizontal rules --- or *** or ___ → ———
    result = result.replace(/^[-*_]{3,}\s*$/gm, '———');

    return result;
  }).join('');
}

// Group messages into turns
const turns = [];
let currentTurn = null;

for (const msg of messages) {
  if (isRealUserMessage(msg)) {
    // Start a new turn
    if (currentTurn) turns.push(currentTurn);
    currentTurn = {user: msg, assistant: []};
  } else if (currentTurn) {
    if (msg.type === 'assistant') {
      currentTurn.assistant.push(msg);
    }
    // user tool_results are part of the current assistant turn, skip them
  }
}
if (currentTurn) turns.push(currentTurn);

// --- Drop the export turn itself ---
// When a session exports itself, the "export this conversation" request is already
// written to the JSONL as the final turn. Dropping it keeps --last N meaning "the N
// turns before I asked". A caller rendering a *finished* or past session omits the
// flag, since its final turn is real content.

const filteredTurns = excludeLastTurn ? turns.slice(0, -1) : turns;

/** All the text of a turn, for --around matching. */
function turnText(turn) {
  const parts = [extractUserText(turn.user)];
  for (const record of turn.assistant) {
    const content = record.message?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) if (block.type === 'text') parts.push(block.text);
    }
  }
  return parts.join('\n').toLowerCase();
}

// Select turns: around a match, or the last N. Each entry keeps the turn's
// 1-based number in the whole session, so --around can label it.
let selectedTurns;
let matchCount = 0;
if (aroundText !== null) {
  const needle = aroundText.toLowerCase();
  const keep = new Set();
  filteredTurns.forEach((turn, i) => {
    if (turnText(turn).includes(needle)) {
      matchCount++;
      for (let j = Math.max(0, i - contextN); j <= Math.min(filteredTurns.length - 1, i + contextN); j++) keep.add(j);
    }
  });
  selectedTurns = [...keep].sort((a, b) => a - b).map((i) => ({turn: filteredTurns[i], number: i + 1}));
} else {
  const start = lastN ? Math.max(0, filteredTurns.length - lastN) : 0;
  selectedTurns = filteredTurns.slice(start).map((turn, k) => ({turn, number: start + k + 1}));
}

// --- Render to markdown ---

function renderTurn(turn) {
  const lines = [];

  // User message. A compaction summary is stored as a user message, but the
  // user didn't write it, so label it as what it is.
  const userText = extractUserText(turn.user);
  const userLabel = turn.user.isCompactSummary
    ? 'Summary of the earlier conversation, written at compaction:'
    : `${userName}:`;
  lines.push(fmt.heading(4, userLabel) + '\n');
  lines.push(slack ? convertMarkdownToSlack(userText) : userText);
  lines.push('');

  // Assistant response
  lines.push(fmt.heading(4, 'Claude:') + '\n');

  for (const record of turn.assistant) {
    const content = record.message?.content;
    if (!content) continue;

    if (typeof content === 'string') {
      lines.push(slack ? convertMarkdownToSlack(content) : content);
      lines.push('');
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        switch (block.type) {
          case 'text': {
            const text = block.text.trim();
            lines.push(slack ? convertMarkdownToSlack(text) : text);
            lines.push('');
            break;
          }

          case 'thinking':
            // Skip thinking blocks by default — they're internal
            break;

          case 'tool_use':
            if (showToolCalls) {
              lines.push(renderToolUse(block));
              lines.push('');
            }
            break;
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Render a tool_use block, and find its matching tool_result.
 */
function renderToolUse(block) {
  const name = block.name;
  const input = block.input || {};
  const toolUseId = block.id;

  // Find the matching tool_result
  const result = findToolResult(toolUseId);

  const lines = [];

  // Render the tool call
  const description = input.description || '';
  const toolLabel = (toolName, suffix) => fmt.bq(`${fmt.bold(fmt.code(toolName))}${suffix || ''}`);

  switch (name) {
    case 'Bash': {
      const cmd = input.command || '';
      lines.push(toolLabel('Bash', description ? ` — ${description}` : ''));
      if (slack) {
        lines.push(fmt.bq('```'));
        lines.push(fmt.bq(cmd));
        lines.push(fmt.bq('```'));
      } else {
        lines.push(fmt.bq('```bash'));
        lines.push(fmt.bq(cmd));
        lines.push(fmt.bq('```'));
      }
      break;
    }
    case 'Read': {
      const path = input.file_path || '';
      lines.push(toolLabel('Read', ` ${path}`));
      break;
    }
    case 'Write': {
      const path = input.file_path || '';
      lines.push(toolLabel('Write', ` ${path}`));
      break;
    }
    case 'Edit': {
      const path = input.file_path || '';
      lines.push(toolLabel('Edit', ` ${path}`));
      break;
    }
    case 'Glob': {
      const pattern = input.pattern || '';
      lines.push(toolLabel('Glob', ` ${fmt.code(pattern)}`));
      break;
    }
    case 'Grep': {
      const pattern = input.pattern || '';
      lines.push(toolLabel('Grep', ` ${fmt.code(pattern)}`));
      break;
    }
    default: {
      lines.push(toolLabel(name));
      if (Object.keys(input).length) {
        if (slack) {
          lines.push(fmt.bq('```'));
          lines.push(fmt.bq(JSON.stringify(input, null, 2).replace(/\n/g, '\n> ')));
          lines.push(fmt.bq('```'));
        } else {
          lines.push(fmt.bq('```json'));
          lines.push(fmt.bq(JSON.stringify(input, null, 2).replace(/\n/g, '\n> ')));
          lines.push(fmt.bq('```'));
        }
      }
    }
  }

  // Render the result (truncated)
  if (result) {
    const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const maxLen = 500;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n…(truncated)' : content;
    const errorPrefix = result.is_error ? fmt.bq(fmt.bold('Error:')) + '\n' : '';
    lines.push(fmt.bq(''));
    lines.push(`${errorPrefix}${fmt.bq('```')}`);
    for (const outputLine of truncated.split('\n')) {
      lines.push(fmt.bq(outputLine));
    }
    lines.push(fmt.bq('```'));
  }

  return lines.join('\n');
}

/**
 * Find a tool_result matching a tool_use_id across all records.
 */
function findToolResult(toolUseId) {
  for (const record of records) {
    if (record.type !== 'user') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        return block;
      }
    }
  }
  return null;
}

// --- Output ---

const localTime = (iso) => new Date(iso).toLocaleString();
const header = [];
header.push(fmt.heading(1, sessionTitle || 'Claude Code Conversation') + '\n');
header.push(`${fmt.bold('Session:')} ${fmt.code(sessionId)}`);
if (sessionCwd) header.push(`${fmt.bold('Directory:')} ${fmt.code(sessionCwd)}`);
if (firstTimestamp) header.push(`${fmt.bold('Dates:')} ${localTime(firstTimestamp)} to ${localTime(lastTimestamp)}`);
header.push(`${fmt.bold('Exported:')} ${new Date().toLocaleString()}`);
header.push('');
if (aroundText !== null) {
  header.push(`${fmt.italic(`${selectedTurns.length} of ${filteredTurns.length} turns, around ${matchCount} that mention "${aroundText}"`)}\n`);
} else if (lastN && lastN < filteredTurns.length) {
  header.push(`${fmt.italic(`showing last ${lastN} of ${filteredTurns.length} turns`)}\n`);
} else {
  header.push(`${fmt.italic(`${filteredTurns.length} turns`)}\n`);
}
header.push(fmt.hr() + '\n');

const body = [];
let previousNumber = null;
for (const {turn, number} of selectedTurns) {
  if (aroundText !== null) {
    if (previousNumber !== null && number > previousNumber + 1) body.push('…\n');
    body.push(fmt.italic(`Turn ${number} of ${filteredTurns.length}`) + '\n');
  }
  body.push(renderTurn(turn));
  body.push(fmt.hr() + '\n');
  previousNumber = number;
}
if (aroundText !== null && matchCount === 0) {
  body.push(fmt.italic(`No turns mention "${aroundText}".`) + '\n');
}

let bodyOutput = body.join('\n');

if (blockquote) {
  bodyOutput = bodyOutput
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
}

process.stdout.write(header.join('\n') + '\n' + bodyOutput);
