#!/usr/bin/env bash
# Development tools only. This does not build a Windows product or validate Win7.
set -euo pipefail
umask 077
repo="${1:?usage: prepare-linux.sh REPOSITORY_ROOT}"
repo="$(cd "$repo" && pwd -P)"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { printf '%s\n' 'LINUX_X64_REQUIRED' >&2; exit 1; }
node_version="$(tr -d '\r\n' < "$repo/.nvmrc")"
[[ "$node_version" == 20.17.0 ]] || { printf '%s\n' 'NODE_PIN_REQUIRES_REVIEW' >&2; exit 1; }
node_sha=a24db3dcd151a52e75965dba04cf1b3cd579ff30d6e0af9da1aede4d0f17486b
export TMPDIR="$HOME/tmp" TMP="$HOME/tmp" TEMP="$HOME/tmp"
mkdir -p "$TMPDIR" "$HOME/.local/opt"
node_home="$HOME/.local/opt/node-v$node_version-linux-x64"
export PATH="$node_home/bin:$PATH"
install_tmp=''
cleanup() { if [[ -n "$install_tmp" ]]; then rm -rf -- "$install_tmp"; fi; }
trap cleanup EXIT
if [[ ! -x "$node_home/bin/node" ]]; then
  install_tmp="$(mktemp -d "$TMPDIR/win7-node-install-XXXXXXXX")"
  archive="$install_tmp/node.tar.xz"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 \
    "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" -o "$archive"
  printf '%s  %s\n' "$node_sha" "$archive" | sha256sum --check --status
  tar -xJf "$archive" -C "$install_tmp"
  mv "$install_tmp/node-v$node_version-linux-x64" "$node_home"
fi
[[ "$(node --version)" == "v$node_version" ]] || { printf '%s\n' 'NODE_VERSION_MISMATCH' >&2; exit 1; }
for package in . src/core src/gateway src/git-adapter src/runner src/shell src/shell/office-lite src/state src/workspace; do
  npm ci --prefix "$repo/$package" --no-audit --no-fund
 done
# Root native SQLite must match the pinned development Node, not the product Electron ABI.
(cd "$repo" && node -e "const S=require('better-sqlite3'); const db=new S(':memory:'); try {db.prepare('SELECT 1').get()} finally {db.close()}")
python3 -I "$repo/scripts/instabox/fingerprint.py" "$repo"
