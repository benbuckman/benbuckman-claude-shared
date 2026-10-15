---
name: dump-slack-threads
description: Copy a Slack conversation verbatim into a Markdown file, with each thread's replies nested under its parent. Use when the user says "/dump-slack-threads", "dump this Slack thread/conversation/channel to a file", "save this Slack conversation", or "export this DM to markdown". It copies text and does not summarize.
argument-hint: "<channel ID or Slack URL> [output path] [since=YYYY-MM-DD] [until=YYYY-MM-DD] [max=N]"
user-invocable: true
---

# Dump a Slack conversation to a file

Copy every post in a Slack conversation, word for word, into one Markdown file, oldest first. A thread's replies are nested under the post that started it. This skill uses the Slack connector's `slack_read_channel` and `slack_read_thread` tools. No Slack API token is needed. To keep a copy up to date on a branch, use [track-slack-thread](../track-slack-thread/SKILL.md), which builds on this skill.

## Inputs

Parse `$ARGUMENTS`. Ask only for what is missing and cannot be defaulted.

- **Target, required:** a channel or DM id (`C…`, `G…`, `D…`), or a Slack URL.
  - **A URL with `thread_ts`:** dump only that thread.
  - **A message URL without `thread_ts`:** dump the whole conversation, starting at that message. Its `p` segment is the message timestamp: `p1790783267406459` is `1790783267.406459`. If the user's words say they want only that message's thread, dump only the thread.
  - **A bare id:** dump the conversation within the limits below.
- **Output path, optional:** default `~/slack-dumps/<conversation-slug>-<YYYY-MM-DD>.md`, where the date is today. The default is outside any repo on purpose. See "Private conversations" under Rules.
- **Limits:**
  - **`since=` and `until=`:** dates. They become the `oldest` and `latest` timestamps of the reads, and `until` includes the whole day.
  - **`max=N`:** the most posts to copy, counting top-level posts and replies together. The default is 300.
  - **Always apply `max`, even with a date range.** It keeps a busy channel from running away. When it stops the dump, say so in the file's header and in the reply.

## Steps

1. **Read the top-level posts:** call `slack_read_channel` with `response_format: "detailed"`, `limit: 100`, and the `oldest` and `latest` from the inputs. Follow `cursor` until there are no more pages or `max` is reached.
   - Always use `detailed`. The concise format has dropped messages before.
   - The tool returns newest first. Reverse the order before writing.
   - If `max` cuts the read short, keep the newest posts. Say in the header that older posts were left out.
2. **Read every thread:** for each post marked `Thread: N replies`, call `slack_read_thread` with `response_format: "detailed"` and `limit: 1000`. Count the replies toward `max`. If a thread would pass the limit, copy the replies that fit and mark the thread as cut off.
3. **Write the file** in the format below. Write it in chunks for a long conversation: the header and the first posts with Write, then append the rest.
4. **Check the file against what you read.** Check only the body below the header, because the Source link can repeat a post's timestamp. `sed '1,/^---$/d' <file>` prints the body.
   - The number of permalinks in the body equals the number of posts you read: `sed '1,/^---$/d' <file> | grep -o 'p[0-9]\{16\}' | wc -l`.
   - No message timestamp appears twice in the body: `sed '1,/^---$/d' <file> | grep -o 'p[0-9]\{16\}' | sort | uniq -d` prints nothing.
   - Every `Thread: N replies` count matches the replies nested under that post, unless the thread is marked as cut off.

   Fix any mismatch before you report.
5. **Report briefly:** the path, the post counts, the date range, and whether a limit cut anything off. Do not summarize the conversation unless asked.

## File format

```markdown
# Slack: <conversation name>

- **Source:** <the Slack URL the user gave, exactly as given. With a bare id, the permalink of the first post copied>
- **Conversation:** [<id>](https://<workspace>.slack.com/archives/<id>), <public channel, private channel, DM, or group DM>
- **Range:** <date of the first post copied> to <date of the last post copied>
- **Posts:** <total> (<top-level> top-level, <replies> replies in <threads> threads)
- **Copied:** <YYYY-MM-DD HH:MM TZ> by Claude, through the Slack MCP, with the dump-slack-threads skill
- **Cut off:** <only when a limit stopped the dump: which limit, and what was left out>

Message text is copied verbatim. Mentions are shown as @Name, links are converted to Markdown, and email addresses are left out. Reactions show counts, not who reacted.

---

- **<Name>** · <YYYY-MM-DD HH:MM TZ> · [link](<permalink>)

  <message text, every line indented two spaces>

  _Reactions: :eyes: 2, :+1: 1_

  - **<Name>** · <YYYY-MM-DD HH:MM TZ> · [link](<reply permalink>)

    <reply text, every line indented four spaces>

- _<Name> has joined the conversation_ · <YYYY-MM-DD HH:MM TZ> · [link](<permalink>)
```

- **Indentation:** a top-level post is a list item. Its text, including blank lines, Slack quotes (`> …`), bullets (`•`), and code blocks, is indented two spaces. Replies are list items indented two spaces, and their text is indented four. This nesting is what makes a thread readable both in a Markdown viewer and as plain text.
- **Line breaks:** end each line that is followed by another line of the same paragraph with two spaces. Markdown otherwise joins the lines, which runs Slack's `•` bullets together. The two spaces don't show in the raw file.
- **Quotes:** when a Slack quote line (`> …`) is followed by a line that is not a quote, put a blank line between them. Otherwise Markdown folds the next line into the quote.
- **Conversation name:** the group DM's name when someone named it, which shows as a "named the conversation" post. Otherwise the channel name, or the participants' names for a DM.
- **Source link:** always include it, so a reader can find the conversation in Slack from the file alone. Each post's own permalink is there to find that post.
- **Workspace:** take it from the URL the user gave. With a bare id, take it from a permalink in the tool output if there is one, and otherwise ask.
- **Permalinks:**
  - **A top-level post:** `https://<workspace>.slack.com/archives/<channel>/p<ts without the dot>`
  - **A reply:** the same, plus `?thread_ts=<parent ts>&cid=<channel>`
- **Times:** as the tool gives them, with the time zone, dropping the seconds
- **Names:** the display name the tool shows. Leave out the email address and the user id.
- **System posts:** show joins, leaves, and renames as one italic line with a permalink, as in the template, so the permalink count in step 4 still matches
- **Reactions:** one italic line after the text, only when the post has reactions
- **Attachments:** one italic line, "_A file is attached in Slack and not copied here._", with the file's name when the tool shows one. Do not download or copy the file.

## Converting Slack's markup

Change only these. Leave all other text as it is, including typos and emoji shortcodes such as `:pray:`.

| Slack | Markdown |
|---|---|
| `<@U123\|Name>` | `@Name` |
| `<@U123>` | `@Name` if the name appears elsewhere in the conversation, otherwise `@U123` |
| `<#C123\|name>` | `#name` |
| `<!here>`, `<!channel>`, `<!subteam^S123\|@group>` | `@here`, `@channel`, `@group` |
| `<https://…\|label>` | `[label](https://…)` |
| `<https://…>` | `<https://…>` |
| `*bold*` | `**bold**` |
| `~strike~` | `~~strike~~` |
| `_italic_` | `_italic_`, unchanged |
| `\/`, `’`, and other JSON escapes in the tool output | the characters they stand for |

## Rules

- **Copy, don't summarize:** no paraphrase, no shortening, no fixing typos. The value of the file is that it matches Slack.
- **No email addresses:** the MCP output includes them, and the file leaves them out.
- **Sensitive data:** if a post contains sensitive personal data, such as health details, dates of birth, or identification numbers, stop. Ask before writing it to a git-tracked location or anywhere it could be shared.
- **Private conversations:** a DM or private channel copied into a repo becomes readable by everyone with access to that repo. Write the file wherever the user says, and mention this in the report when the target is private and the path is inside a repo. Do not commit or push unless asked.
- **Read-only:** do not post, react, or mark anything as read in Slack
