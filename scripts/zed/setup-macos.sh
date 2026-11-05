#!/bin/sh
# Sets up this fork of omp as an ACP agent for Zed on macOS.
#
#   1. Checks the toolchain: Xcode Command Line Tools, Bun >= 1.4.4 and rustup.
#      The native addon needs the nightly Rust pinned in rust-toolchain.toml,
#      which only rustup can install. Homebrew's `rust` formula is not enough.
#   2. Installs the workspace and builds @oh-my-pi/pi-natives.
#   3. Links the dev launcher as `omp-fork` in ~/.local/bin. That way the fork
#      does not clash with a release `omp` from Homebrew or omp.sh/install.
#   4. Prints the agent_servers block for ~/.config/zed/settings.json and
#      copies it to the clipboard.
#
# Re-running the script is safe. After a TypeScript change no rebuild is
# needed: the launcher runs the sources directly. After a Rust change,
# re-run with --native-only.
#
# Usage: scripts/zed/setup-macos.sh [--native-only] [--name <agent name>]
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
launcher=$repo_root/packages/coding-agent/scripts/omp
bin_dir=${OMP_FORK_BIN_DIR:-$HOME/.local/bin}
link_path=$bin_dir/omp-fork
agent_name="omp (fork)"
native_only=0

while [ $# -gt 0 ]; do
	case $1 in
	--native-only) native_only=1 ;;
	--name)
		shift
		agent_name=${1:?--name needs a value}
		;;
	-h | --help)
		sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		exit 2
		;;
	esac
	shift
done

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die() {
	printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
	exit 1
}

[ "$(uname -s)" = Darwin ] || die "This script is for macOS only."

# --- 1. Toolchain -----------------------------------------------------------
say "Checking the toolchain"

xcode-select -p >/dev/null 2>&1 ||
	die "No Xcode Command Line Tools. Run: xcode-select --install"

# A GUI app (and this script under it) may not have ~/.bun/bin or ~/.cargo/bin
# on PATH.
PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

if ! command -v bun >/dev/null 2>&1; then
	die "Bun not found. Install it: curl -fsSL https://bun.sh/install | bash  (or: brew install oven-sh/bun/bun)"
fi
bun_version=$(bun --version)
bun_major=${bun_version%%.*}
bun_rest=${bun_version#*.}
bun_minor=${bun_rest%%.*}
bun_rest=${bun_rest#*.}
bun_patch=${bun_rest%%[!0-9]*}
if [ "$bun_major" -lt 1 ] ||
	{ [ "$bun_major" -eq 1 ] && [ "$bun_minor" -lt 4 ]; } ||
	{ [ "$bun_major" -eq 1 ] && [ "$bun_minor" -eq 4 ] && [ "${bun_patch:-0}" -lt 4 ]; }; then
	die "Bun $bun_version is too old, need >= 1.4.4. Run: bun upgrade"
fi
echo "  bun $bun_version"

if ! command -v rustup >/dev/null 2>&1; then
	die "rustup not found. Install it: curl https://sh.rustup.rs -sSf | sh  (or: brew install rustup && rustup-init)"
fi
# rustup pulls the nightly from rust-toolchain.toml on first use in the repo.
(cd "$repo_root" && rustup toolchain install) ||
	die "Could not install the Rust toolchain from rust-toolchain.toml"
echo "  rust $(cd "$repo_root" && rustc --version)"

# --- 2. Dependencies and native addon ---------------------------------------
cd "$repo_root"
if [ "$native_only" -eq 0 ]; then
	say "bun install"
	bun install
fi
say "Building the native addon (the first build takes a while)"
bun run build:native

# --- 3. Launcher ------------------------------------------------------------
[ -x "$launcher" ] || die "Launcher not found: $launcher"
mkdir -p "$bin_dir"
ln -sfn "$launcher" "$link_path"
say "Linked: $link_path -> $launcher"

case ":$PATH:" in
*":$bin_dir:"*) ;;
*) warn "$bin_dir is not on your shell PATH. Zed does not care, but for the terminal add to ~/.zshrc: export PATH=\"$bin_dir:\$PATH\"" ;;
esac

say "Smoke test"
"$link_path" --version || die "omp-fork does not start. Check the output above."

# --- 4. Zed settings snippet ------------------------------------------------
bun_dir=$(dirname "$(command -v bun)")
snippet=$(
	cat <<EOF
  "agent_servers": {
    "$agent_name": {
      "type": "custom",
      "command": "$link_path",
      "args": ["acp"],
      "env": {
        "PATH": "$bun_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    }
  }
EOF
)

say "Add this to ~/.config/zed/settings.json (inside the top-level object):"
printf '%s\n' "$snippet"
if command -v pbcopy >/dev/null 2>&1; then
	printf '%s\n' "$snippet" | pbcopy
	echo "(copied to the clipboard)"
fi

cat <<EOF

Next:
  1. In Zed: cmd-, (Open Settings), paste the block, save.
  2. Open the Agent Panel (cmd-?), click + and pick "$agent_name".
  3. Sign in to a model provider once in the terminal if you have not yet:
     omp-fork   then /login
EOF
