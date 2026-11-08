#!/bin/sh
# Restart the installed hub as soon as it has been idle for 30 seconds: for when the person asks for a restart now (the
# five-minute watcher, for every other restart, is restart-when-idle.sh). The same checks as that watcher, over a shorter
# window: no reply running or queued and none that moved in the last 30 seconds, no Ask others question queued or
# running, nothing the hub says it's busy with (run/busy.json, hub/src/busyFile.ts: background work its agents still
# run, like a test suite Claude Code started in the background, and wake-ups they owe, like a helper's report about to
# be answered), and no Claude Code transcript written in the last minute. Gives up after an hour. Then it says whether
# the installed version came back.
# On macOS it restarts the LaunchAgent (CROSSTALK_LABEL, default com.crosstalk.hub), on Linux the systemd user service
# (CROSSTALK_UNIT, default crosstalk-hub). CROSSTALK_HOME and CROSSTALK_PORT as the hub reads them. What it did goes to
# CROSSTALK_RESTART_LOG (default: the watcher's log on a Mac, standard output elsewhere).
DIR="${CROSSTALK_HOME:-$HOME/.crosstalk}"
DB="$DIR/crosstalk.db"
BUSY="$DIR/run/busy.json"
LABEL="${CROSSTALK_LABEL:-com.crosstalk.hub}"
UNIT="${CROSSTALK_UNIT:-crosstalk-hub}"
PORT="${CROSSTALK_PORT:-7420}"
if [ -n "$CROSSTALK_RESTART_LOG" ]; then
  LOG="$CROSSTALK_RESTART_LOG"
elif [ "$(uname -s)" = "Darwin" ]; then
  LOG="$HOME/Library/Logs/Crosstalk/restart-when-idle.log"
else
  LOG=/dev/stdout
fi
say() {
  echo "$(date) $*" >> "$LOG"
}
end=$(( $(date +%s) + 3600 ))
idle_since=0
# "running or queued|newest time (ms) anything moved" for a table with status, created_at, started_at and ended_at.
probe() {
  sqlite3 -readonly "$DB" "select coalesce(sum(case when status in ('running','queued') then 1 else 0 end),0) || '|' || coalesce(max(max(created_at,coalesce(started_at,0),coalesce(ended_at,0))),0) from $1" 2>/dev/null
}
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(date +%s)
  # Completed activity too, so a short reply entirely between two looks still starts the quiet spell again.
  activity=$(probe turns) || activity=unknown
  # Ask others' one-shot questions have no turn: queued or running ones count as busy the same way. A hub from before
  # 0.4 has no asks table, which means none.
  asks=0
  case "$(sqlite3 -readonly "$DB" "select count(*) from sqlite_master where type='table' and name='asks'" 2>/dev/null)" in
    0) ;;
    1) asks=$(probe asks) || asks=unknown ;;
    *) asks=unknown ;;
  esac
  busy=0
  latest=0
  for part in "$activity" "$asks"; do
    case "$part" in
      0) ;;
      *'|'*)
        count=${part%%|*}
        newest=${part#*|}
        case "$count" in ''|*[!0-9]*) busy=unknown ;; esac
        case "$newest" in ''|*[!0-9]*) busy=unknown ;; esac
        if [ "$busy" != "unknown" ]; then
          busy=$((busy + count))
          [ "$newest" -le "$latest" ] || latest=$newest
        fi
        ;;
      *) busy=unknown ;;
    esac
  done
  # The hub's own word on background work and owed wake-ups: busy while it lists any, or can't be read. Rewritten every
  # minute, so one unchanged for three minutes is from a hub that isn't running, and says nothing.
  if [ -f "$BUSY" ] && [ -n "$(find "$BUSY" -mmin -3 -print 2>/dev/null)" ]; then
    held=$(sed -n 's/^{"count":\([0-9][0-9]*\),.*/\1/p' "$BUSY" 2>/dev/null | head -n 1)
    case "$held" in
      0) ;;
      ''|*[!0-9]*) busy=unknown ;;
      *) [ "$busy" = "unknown" ] || busy=$((busy + held)) ;;
    esac
  fi
  # Claude Code still writing a session's transcript (a helper, a turn it took up by itself) in the last minute.
  recent=0
  sessions=$(sqlite3 -readonly "$DB" "select json_extract(session,'$.sessionId') from members where provider='claude' and json_extract(session,'$.sessionId') is not null" 2>/dev/null) || recent=1
  for id in $sessions; do
    for p in "$HOME"/.claude/projects/*/"$id".jsonl "$HOME"/.claude/projects/*/"$id"; do
      [ -e "$p" ] || continue
      matches=$(find "$p" -mmin -1 -print -quit 2>/dev/null) || recent=1
      [ -z "$matches" ] || recent=1
    done
  done
  if [ "$busy" = "0" ]; then
    [ "$idle_since" -ne 0 ] || idle_since=$now
    latest_seconds=$((latest / 1000))
    [ "$latest_seconds" -le "$idle_since" ] || idle_since=$latest_seconds
    if [ $((now - idle_since)) -ge 30 ] && [ "$recent" = "0" ]; then
      if [ "$(uname -s)" = "Linux" ]; then
        # `systemctl restart` also starts a stopped unit, so a hub stopped meanwhile stays stopped.
        if ! systemctl --user is-active --quiet "$UNIT"; then
          say "hub isn't running (stopped meanwhile?); not restarted"
          exit 0
        fi
        say "restarting hub now (asked for), idle for 30 seconds"
        systemctl --user restart "$UNIT"
      else
        say "restarting hub now (asked for), idle for 30 seconds"
        launchctl kickstart -k "gui/$(id -u)/$LABEL"
      fi
      # Then whether the installed version came back (the old one can answer for a moment).
      want=$("$HOME/.local/bin/crosstalk-hub" version 2>/dev/null)
      v=""
      for _ in $(seq 1 60); do
        sleep 2
        v=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
        if [ -n "$v" ] && [ "$v" = "$want" ]; then
          say "hub is back: $v"
          exit 0
        fi
      done
      say "hub didn't come back as ${want:-the installed version} within 2 minutes (last answer: ${v:-none})"
      exit 1
    fi
  else
    idle_since=0
  fi
  sleep 5
done
say "gave up waiting for the hub to go idle; not restarted"
exit 1
