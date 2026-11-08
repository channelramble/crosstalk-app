#!/bin/sh
# Restart the installed hub only after five continuous idle minutes.
# Background Claude helpers must also have stopped writing for five minutes.
# Run once after staging a tested binary; gives up after six hours.
# On macOS it restarts the LaunchAgent (CROSSTALK_LABEL, default com.crosstalk.hub), on Linux the systemd user service
# (CROSSTALK_UNIT, default crosstalk-hub). The database is the one the hub uses: CROSSTALK_HOME, as the hub reads it.
# What the hub is busy with that the database doesn't show is in its run/busy.json (hub/src/busyFile.ts): background
# work its agents still run (a test suite Claude Code started in the background writes to its own output file, not the
# transcript) and wake-ups they owe (a helper's report about to be answered). That counts as busy too. The hub rewrites it
# every minute: one unchanged for three minutes is from a hub that isn't running, and says nothing.
DB="${CROSSTALK_HOME:-$HOME/.crosstalk}/crosstalk.db"
BUSY="${CROSSTALK_HOME:-$HOME/.crosstalk}/run/busy.json"
LABEL="${CROSSTALK_LABEL:-com.crosstalk.hub}"
UNIT="${CROSSTALK_UNIT:-crosstalk-hub}"
end=$(( $(date +%s) + 21600 ))
idle_since=0
# "running or queued|newest time (ms) anything moved" for a table with status, created_at, started_at and ended_at.
probe() {
  sqlite3 -readonly "$DB" "select coalesce(sum(case when status in ('running','queued') then 1 else 0 end),0) || '|' || coalesce(max(max(created_at,coalesce(started_at,0),coalesce(ended_at,0))),0) from $1" 2>/dev/null
}
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(date +%s)
  # Include completed activity so a short turn entirely between polls still resets the idle clock.
  activity=$(probe turns) || activity=unknown
  # Ask others' one-shot questions (0.4) have no turn: queued or running ones count as busy the same way. A hub from
  # before 0.4 has no asks table yet, which means none.
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
  # The hub's own word on background work and owed wake-ups (busy.json): busy while it lists any, or can't be read.
  if [ -f "$BUSY" ] && [ -n "$(find "$BUSY" -mmin -3 -print 2>/dev/null)" ]; then
    held=$(sed -n 's/^{"count":\([0-9][0-9]*\),.*/\1/p' "$BUSY" 2>/dev/null | head -n 1)
    case "$held" in
      0) ;;
      ''|*[!0-9]*) busy=unknown ;;
      *) [ "$busy" = "unknown" ] || busy=$((busy + held)) ;;
    esac
  fi
  recent=0
  sessions=$(sqlite3 -readonly "$DB" "select json_extract(session,'$.sessionId') from members where provider='claude' and json_extract(session,'$.sessionId') is not null" 2>/dev/null) || recent=1
  for id in $sessions; do
    for p in "$HOME"/.claude/projects/*/"$id".jsonl "$HOME"/.claude/projects/*/"$id"; do
      [ -e "$p" ] || continue
      matches=$(find "$p" -mmin -5 -print -quit 2>/dev/null) || recent=1
      [ -z "$matches" ] || recent=1
    done
  done
  if [ "$busy" = "0" ]; then
    [ "$idle_since" -ne 0 ] || idle_since=$now
    latest_seconds=$((latest / 1000))
    [ "$latest_seconds" -le "$idle_since" ] || idle_since=$latest_seconds
    if [ $((now - idle_since)) -ge 300 ] && [ "$recent" = "0" ]; then
      if [ "$(uname -s)" = "Linux" ]; then
        # `systemctl restart` also starts a stopped unit, so a hub stopped meanwhile stays stopped. (launchctl's
        # kickstart -k refuses a job that was booted out.)
        if ! systemctl --user is-active --quiet "$UNIT"; then
          echo "$(date) hub isn't running (stopped meanwhile?); not restarted"
          exit 0
        fi
        echo "$(date) restarting hub after five idle minutes"
        systemctl --user restart "$UNIT"
      else
        echo "$(date) restarting hub after five idle minutes"
        launchctl kickstart -k "gui/$(id -u)/$LABEL"
      fi
      exit $?
    fi
  else
    idle_since=0
  fi
  sleep 60
done
echo "$(date) hub never went idle; not restarted"
exit 1
