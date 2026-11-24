// Node.js for the agents that run on it (Gemini CLI, OpenCode), on a machine that has none. Their installers used to
// stop with "install Node.js first", which is a terminal and a package manager away for most people. Instead Crosstalk
// gets Node.js's own build into a folder of its own and uses it for what it starts: nothing else on the machine sees
// it, and a Node.js the machine already has (or gets later) is always used first.

import { homedir } from "node:os";
import { join } from "node:path";

/** The long-term-support line it takes the newest release of. */
const NODE_LINE = "latest-v26.x";

/** Where it lives: as the shell says it, and its programs' folder for the PATH of what Crosstalk starts. */
const OWN_NODE = '"$HOME/.local/share/crosstalk/node"';
export const ownNodeBin = () => join(homedir(), ".local/share/crosstalk/node/bin");

/**
 * Shell (bash, under `set -e`) that makes `npm` available for the lines after it: the machine's own when it has one,
 * else Crosstalk's, downloaded from nodejs.org and checked against the release's SHA256 list the first time.
 * `name`: the agent it's for, said while it downloads.
 */
export function withNpm(name: string): string {
  return [
    `if ! command -v npm >/dev/null 2>&1; then N=${OWN_NODE}`,
    `if [ ! -x "$N/bin/npm" ]; then echo "${name} runs on Node.js, and this machine has none. Getting one for Crosstalk's own use (nothing else on the machine changes)…"`,
    `case "$(uname -sm)" in "Darwin arm64") P=darwin-arm64 ;; "Darwin x86_64") P=darwin-x64 ;; "Linux x86_64") P=linux-x64 ;; "Linux aarch64" | "Linux arm64") P=linux-arm64 ;; *) echo "Node.js has no ready-made build for this kind of machine ($(uname -sm)). Install Node.js yourself, then try again."; exit 1 ;; esac`,
    `B=https://nodejs.org/dist/${NODE_LINE}; D="$(mktemp -d)"; curl -fsSL "$B/SHASUMS256.txt" -o "$D/sums"`,
    `F="$(awk -v p="-$P.tar.gz" '$2 ~ /^node-v/ && index($2, p) { print $2; exit }' "$D/sums")"; [ -n "$F" ] || { echo "Couldn't find Node.js for this machine at nodejs.org."; exit 1; }`,
    `curl -fL --progress-bar "$B/$F" -o "$D/$F"`,
    `(cd "$D" && grep "  $F\\$" sums > want && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c want >/dev/null; else shasum -a 256 -c want >/dev/null; fi) || { echo "The Node.js download doesn't match its checksum. Nothing was installed; try again."; exit 1; }`,
    `rm -rf "$N.new"; mkdir -p "$N.new"; tar -xzf "$D/$F" -C "$N.new" --strip-components=1; rm -rf "$N"; mv "$N.new" "$N"; rm -rf "$D"; echo "Node.js $("$N/bin/node" --version) is ready."; fi`,
    `export PATH="$N/bin:$PATH"; fi`,
  ].join("; ");
}
