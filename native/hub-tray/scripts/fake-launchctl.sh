#!/bin/sh
# A stand-in launchctl for trying and testing Crosstalk Hub without the real one: it runs one test hub from the plist it
# is given (or its label's plist in $HOME/Library/LaunchAgents), isolated like hub/scripts/e2e.ts, and logs every call.
# Copy it to <trial>/bin/launchctl; it keeps its state in <trial>/state. It never calls the real launchctl, and the
# hub it starts is the trial's (the plist's own program, port and data folder).
TRIAL="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$TRIAL/state"
mkdir -p "$STATE"
echo "$(date '+%H:%M:%S') launchctl $*" >>"$STATE/calls.log"

running() { [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; }
label_of() { echo "${1##*/}"; }

start() {
  plist="$1"
  running && return 0
  [ -f "$plist" ] || { echo "Bootstrap failed: 2: No such file or directory" >&2; return 2; }
  bin=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")
  log=$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$plist" 2>/dev/null || echo "$STATE/hub.log")
  mkdir -p "$(dirname "$log")"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' "$plist" | sed -n 's/^ *\([A-Za-z_][A-Za-z0-9_]*\) = \(.*\)$/\1=\2/p' >"$STATE/env"
  set --
  while IFS= read -r kv; do set -- "$@" "$kv"; done <"$STATE/env"
  # Nothing of this computer's: no agent CLIs, Tailscale, price lists, model servers or downloads.
  env -i "$@" PATH=/usr/bin:/bin:/usr/sbin:/sbin CROSSTALK_WORKSPACES="$TRIAL/workspaces" CROSSTALK_NO_AGENT_CLIS=1 \
    CROSSTALK_PRICES_URL=http://127.0.0.1:9/prices.json CROSSTALK_LOCAL_SERVER_PORTS= CROSSTALK_TAILSCALE_BIN="$TRIAL/no-tailscale" \
    CROSSTALK_GITHUB_API=http://127.0.0.1:9 CROSSTALK_LLAMA_RELEASES=http://127.0.0.1:9 CROSSTALK_HF_URL=http://127.0.0.1:9 \
    "$bin" serve >>"$log" 2>&1 </dev/null &
  echo $! >"$STATE/pid"
  echo "$plist" >"$STATE/plist"
}

stop() {
  running || return 0
  pid=$(cat "$STATE/pid")
  kill "$pid" 2>/dev/null
  # Like launchd's exit timeout: SIGKILL after five seconds.
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  kill -9 "$pid" 2>/dev/null
  rm -f "$STATE/pid"
}

case "$1" in
  print)
    if running; then
      printf '%s = {\n\tstate = running\n\tpid = %s\n\tlast exit code = 0\n}\n' "$2" "$(cat "$STATE/pid")"
    else
      echo "Bad request."
      echo "Could not find service \"$(label_of "$2")\" in domain for user gui: $(id -u)"
      exit 113
    fi
    ;;
  bootstrap) start "$3" ;;
  bootout)
    if running; then stop; else
      echo "Boot-out failed: 3: No such process" >&2
      exit 3
    fi
    ;;
  kickstart)
    if [ "$2" = "-k" ]; then
      shift
      stop
    fi
    start "$(cat "$STATE/plist" 2>/dev/null || echo "$HOME/Library/LaunchAgents/$(label_of "$2").plist")"
    ;;
  enable | disable) ;;
  *)
    echo "launchctl (stand-in): $1 isn't done here" >&2
    exit 64
    ;;
esac
