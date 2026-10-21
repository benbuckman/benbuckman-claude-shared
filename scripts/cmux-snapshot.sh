#!/bin/bash
# Snapshots every cmux terminal surface, so that a cmux restart can be checked afterward.
# See "Restarting cmux" in ../claude--working-with-tmux.md.
#
# Usage:
#   cmux-snapshot.sh <folder>                    write a snapshot into <folder>
#   cmux-snapshot.sh compare <before> <after>    compare two snapshots
#
# A snapshot holds, for each terminal surface: its workspace, ref, and title; the
# command cmux runs to resume it; its visible screen; the processes that name its
# Claude Code session ID; and the size and last-change time of the session's
# transcript. It also copies cmux's saved layout and its Claude Code session records.
#
# Screens and titles can contain anything the sessions showed. Keep snapshots out of git.
set -uo pipefail

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
uuid_re='[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'

snapshot() {
  local out="$1"
  mkdir -p "$out/surfaces" "$out/state"
  date '+%Y-%m-%dT%H:%M:%S%z' >"$out/taken-at.txt"
  cmux version >"$out/cmux-version.txt" 2>&1

  cmux tree --all >"$out/tree.txt" 2>&1
  cmux tree --all --id-format both >"$out/tree-with-uuids.txt" 2>&1
  cmux sessions list --all >"$out/claude-session-records.txt" 2>&1
  cp -p "$HOME/Library/Application Support/cmux/session-com.cmuxterm.app.json" "$out/state/" 2>/dev/null
  cp -p "$HOME/.cmuxterm/claude-hook-sessions.json" "$out/state/" 2>/dev/null

  printf 'workspace\tsurface\tsession_id\ttranscript_bytes\ttranscript_modified\ttitle\n' >"$out/surfaces.tsv"
  local ws="" line ref title n id transcript bytes modified
  while IFS= read -r line; do
    if [[ "$line" =~ workspace\ (workspace:[0-9]+) ]]; then ws="${BASH_REMATCH[1]}"; fi
    [[ "$line" =~ surface\ (surface:[0-9]+)\ \[terminal\]\ \"(.*)\" ]] || continue
    ref="${BASH_REMATCH[1]}"
    # Drop the status marker that Claude Code puts before its title, such as ✳ or ◐.
    title="$(sed -E 's/^[^[:alnum:]`]+ //' <<<"${BASH_REMATCH[2]}")"
    n="${ref#surface:}"

    cmux read-screen --workspace "$ws" --surface "$ref" --scrollback >"$out/surfaces/surface-$n.screen.txt" 2>&1
    cmux surface resume show --surface "$ref" >"$out/surfaces/surface-$n.resume.txt" 2>&1

    id="$(grep -o -E "$uuid_re" "$out/surfaces/surface-$n.resume.txt" | head -1)"
    bytes="-" modified="-"
    if [[ -n "$id" ]]; then
      # cmux tree's tty= can be stale after a restart, so find processes by session ID.
      ps -axo pid=,lstart=,command= | grep -F -- "$id" | grep -v -F 'grep' \
        >"$out/surfaces/surface-$n.processes.txt"
      transcript="$(ls "$claude_dir"/projects/*/"$id".jsonl 2>/dev/null | head -1)"
      if [[ -n "$transcript" ]]; then
        bytes="$(stat -f %z "$transcript")"
        modified="$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$transcript")"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ws" "$ref" "${id:--}" "$bytes" "$modified" "$title" >>"$out/surfaces.tsv"
  done <"$out/tree.txt"

  echo "Wrote $(($(wc -l <"$out/surfaces.tsv") - 1)) surfaces to $out"
}

# Compares by session ID, because cmux renumbers every ref when it restarts.
compare() {
  local before="$1" after="$2"
  local taken_before taken_after
  taken_before="$(cat "$before/taken-at.txt" 2>/dev/null)"
  taken_after="$(cat "$after/taken-at.txt" 2>/dev/null)"
  echo "Before: $taken_before, $(cat "$before/cmux-version.txt" 2>/dev/null)"
  echo "After:  $taken_after, $(cat "$after/cmux-version.txt" 2>/dev/null)"
  echo

  local ws ref id bytes modified title
  local a_ref a_bytes a_modified size process
  printf '%-8s  %-10s  %-7s  %-8s  %s\n' "session" "transcript" "process" "written" "title"
  while IFS=$'\t' read -r ws ref id bytes modified title; do
    [[ "$id" == "-" || "$id" == "session_id" ]] && continue
    a_ref="" a_bytes="" a_modified=""
    IFS=$'\t' read -r _ a_ref _ a_bytes a_modified _ < <(grep -F -- "$id" "$after/surfaces.tsv" | head -1)
    if [[ -z "$a_ref" ]]; then
      printf '%-8s  %-10s  %-7s  %-8s  %s\n' "${id:0:8}" "-" "-" "-" "$title (no surface after)"
      continue
    fi
    if [[ "$bytes" == "-" || "$a_bytes" == "-" ]]; then size="missing"
    elif ((a_bytes < bytes)); then size="SHRANK"
    elif ((a_bytes == bytes)); then size="same"
    else size="grew"; fi
    process="no"
    [[ -s "$after/surfaces/surface-${a_ref#surface:}.processes.txt" ]] && process="yes"
    printf '%-8s  %-10s  %-7s  %-8s  %s\n' "${id:0:8}" "$size" "$process" "${a_modified:11}" "$title"
  done <"$before/surfaces.tsv"

  echo
  echo "Surfaces only in the after snapshot:"
  comm -13 <(cut -f3 "$before/surfaces.tsv" | sort) <(cut -f3 "$after/surfaces.tsv" | sort) |
    while read -r id; do grep -F -- "$id" "$after/surfaces.tsv" | cut -f2,6; done
  cat <<'EOF'

process: yes when a running process names the session ID. cmux resumes a session with
  `claude --resume <id>`, so its process names the ID. A session resumed by hand with
  `claude -r` doesn't, so check its "written" time instead.
written: when the transcript last changed. Every session writes once as cmux quits.
  A session that resumed writes again within seconds of the relaunch.
EOF
}

case "${1:-}" in
  compare)
    [[ $# -eq 3 ]] || { echo "Usage: $0 compare <before> <after>" >&2; exit 2; }
    compare "$2" "$3" ;;
  "" | -h | --help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  *)
    snapshot "$1" ;;
esac
