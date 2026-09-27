#!/usr/bin/env bash
# Install or update ShuraCode: the engine (OpenCode, from npm), the config in ~/.config/shuracode, the memory
# and the `shuracode` command. Idempotent; files that differ are backed up before being replaced.
#
#   ./install.sh [--engine VERSION|latest] [--base-url URL] [--status-url URL|""] [--no-browser]
#
#   --engine      engine version to install (default: the tested version in ENGINE_VERSION, or keep the
#                 installed one). A new engine is switched to only if the self-test passes.
#   --base-url    OpenAI-compatible endpoint of the model (default: the Shura gateway, http://127.0.0.1:8080/v1)
#   --status-url  model status shown in the UI (default: the Shura gateway status; "" hides it)
#   --no-browser  skip installing Chromium for the browser tool
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${SHURACODE_HOME:-$HOME/.local/share/shuracode}"
CONFIG="${SHURACODE_CONFIG_DIR:-$HOME/.config/shuracode}"
ENGINE_WANTED="" BASE_URL="http://127.0.0.1:8080/v1" STATUS_URL="http://127.0.0.1:8080/guardian/status" BROWSER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE_WANTED="$2"; shift ;;
    --base-url) BASE_URL="$2"; shift ;;
    --status-url) STATUS_URL="$2"; shift ;;
    --no-browser) BROWSER="" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
stamp="$(date +%Y%m%d-%H%M%S)"

# put SRC DST: replace DST atomically, backing it up first if it differs; returns 1 if nothing changed
put() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 1; fi
  mkdir -p "$(dirname "$2")"
  if [ -f "$2" ]; then cp -p "$2" "$2.bak-$stamp"; info "backed up $2"; fi
  local tmp; tmp="$(dirname "$2")/.$(basename "$2").tmp.$$"
  cp "$1" "$tmp" && mv -f "$tmp" "$2"
}
render() {  # render TEMPLATE -> stdout
  sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@BASE_URL@|$BASE_URL|g" -e "s|@STATUS_URL@|$STATUS_URL|g" "$1"
}

say "Checking prerequisites"
for cmd in node npm python3 curl; do command -v "$cmd" >/dev/null || die "$cmd is required"; done
info "node $(node --version), npm $(npm --version), $(python3 --version)"

# ------------------------------------------------------------------------------------------- config
say "Config (~/.config/shuracode)"
mkdir -p "$CONFIG/commands"
tmp="$(mktemp)"
render "$REPO_DIR/config/shuracode.json.in" > "$tmp"; put "$tmp" "$CONFIG/shuracode.json" || true
chmod 600 "$CONFIG/shuracode.json"
render "$REPO_DIR/config/tui.json.in" > "$tmp"; put "$tmp" "$CONFIG/tui.json" || true
rm -f "$tmp"
put "$REPO_DIR/config/AGENTS.md" "$CONFIG/AGENTS.md" || true
for f in "$REPO_DIR"/commands/*.md; do put "$f" "$CONFIG/commands/$(basename "$f")" || true; done
info "model endpoint: $BASE_URL"

# ------------------------------------------------------------------------------------------- memory
say "Memory (~/.local/share/shuracode/memory)"
old="$HOME/.local/share/shura/memory"  # location used by Shura before ShuraCode existed
if [ -d "$old" ] && [ ! -e "$DATA/memory/MEMORY.md" ]; then
  mkdir -p "$DATA/memory"
  find "$old" -maxdepth 1 -name '*.md' ! -name MEMORY.md -exec mv -n {} "$DATA/memory/" \;
  info "moved existing memories from $old"
fi
python3 "$REPO_DIR/mcp/memory.py" < /dev/null  # creates the folder (0700) and its index
info "$(find "$DATA/memory" -name '*.md' ! -name MEMORY.md | wc -l) memories"

# ------------------------------------------------------------------------------- earlier Shura files
# Shura used to put this config straight into ~/.config/opencode. The engine still reads that folder, so
# leftovers would be merged into ShuraCode (duplicate rules and commands). Move only files Shura wrote.
legacy="$HOME/.config/opencode" moved=""
shura_file() {
  case "$1" in
    */opencode.json) grep -q '"tiel-local"' "$1" ;;
    */AGENTS.md) grep -q '^# Verification discipline' "$1" ;;
    */tui.json) grep -q '"theme": "shura"' "$1" && [ "$(wc -l < "$1")" -le 5 ] ;;
    */commands/*.md) [ -f "$REPO_DIR/commands/$(basename "$1")" ] ;;
    *) false ;;
  esac
}
for f in "$legacy"/opencode.json "$legacy"/AGENTS.md "$legacy"/tui.json \
         "$legacy"/commands/{remember,forget,memory,test,commit}.md; do
  if [ -f "$f" ] && shura_file "$f"; then
    dest="$legacy/moved-to-shuracode-$stamp/${f#"$legacy/"}"
    mkdir -p "$(dirname "$dest")" && mv "$f" "$dest" && moved=1
  fi
done
if [ -n "$moved" ]; then
  say "Moved Shura's old files out of ~/.config/opencode"
  info "to $legacy/moved-to-shuracode-$stamp (plain OpenCode keeps working with its own config)"
fi

# ------------------------------------------------------------------------------------------- engine
say "Engine (OpenCode)"
mkdir -p "$DATA/engine" "$DATA/libexec"
current="$(cat "$DATA/engine/current" 2>/dev/null || true)"
if [ "$ENGINE_WANTED" = latest ]; then
  ENGINE_WANTED="$(npm view opencode-ai version 2>/dev/null)" || die "cannot reach the npm registry"
elif [ -z "$ENGINE_WANTED" ]; then
  ENGINE_WANTED="${current:-$(cat "$REPO_DIR/ENGINE_VERSION")}"
fi
dir="$DATA/engine/$ENGINE_WANTED"
if [ ! -x "$dir/bin" ]; then
  info "downloading OpenCode $ENGINE_WANTED (~190 MB, one time)"
  rm -rf "$dir.tmp"
  npm install --prefix "$dir.tmp" --no-fund --no-audit --loglevel=error "opencode-ai@$ENGINE_WANTED" >/dev/null \
    || { rm -rf "$dir.tmp"; die "npm install opencode-ai@$ENGINE_WANTED failed"; }
  pkg="$dir.tmp/node_modules/opencode-ai"
  [ -f "$pkg/bin/opencode.exe" ] || (cd "$pkg" && node ./postinstall.mjs >/dev/null)
  [ -x "$pkg/bin/opencode.exe" ] || { rm -rf "$dir.tmp"; die "engine binary missing after install"; }
  ln -sfn "node_modules/opencode-ai/bin/opencode.exe" "$dir.tmp/bin"
  mv "$dir.tmp" "$dir"
fi
if [ "$ENGINE_WANTED" != "$current" ]; then
  info "self-test of OpenCode $ENGINE_WANTED with ShuraCode"
  if SHURACODE_ENGINE="$dir/bin" python3 "$REPO_DIR/tests/selftest.py"; then
    ln -sfn "$(readlink -f "$dir/bin")" "$DATA/libexec/.shuracode.$$" && mv -Tf "$DATA/libexec/.shuracode.$$" "$DATA/libexec/shuracode"
    [ -n "$current" ] && echo "$current" > "$DATA/engine/previous"
    echo "$ENGINE_WANTED" > "$DATA/engine/current"
    info "now using OpenCode $ENGINE_WANTED${current:+ (previous: $current, 'shuracode rollback' to go back)}"
    keep="$ENGINE_WANTED $current"
    for d in "$DATA"/engine/*/; do  # keep the current and previous engine only
      v="$(basename "$d")"; case " $keep " in *" $v "*) ;; *) rm -rf "$d"; info "removed old engine $v" ;; esac
    done
  elif [ -n "$current" ]; then
    rm -rf "$dir"
    die "OpenCode $ENGINE_WANTED failed the ShuraCode self-test - staying on $current"
  else
    die "the ShuraCode self-test failed on OpenCode $ENGINE_WANTED - see the output above"
  fi
else
  info "OpenCode $current (up to date with this install)"
fi

# ------------------------------------------------------------------------------------------ command
say "Command"
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/bin/shuracode" "$HOME/.local/bin/shuracode"
info "$HOME/.local/bin/shuracode -> $("$REPO_DIR/bin/shuracode" version)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) info "add ~/.local/bin to PATH to use 'shuracode' everywhere" ;; esac

if [ -n "$BROWSER" ] && ! ls -d "$HOME"/.cache/ms-playwright/chromium-* >/dev/null 2>&1; then
  say "Browser for the web tool (Chromium via Playwright)"
  npx -y @playwright/mcp@latest --version >/dev/null 2>&1 || true
  pw="$(find "$HOME/.npm/_npx" -path '*node_modules/playwright/cli.js' 2>/dev/null | head -1)"
  if [ -n "$pw" ] && (cd "$(dirname "$pw")" && node cli.js install chromium >/dev/null 2>&1); then info "installed"
  else info "skipped (the browser tool will not work until Chromium is installed)"; fi
fi

say "Done - run: shuracode"
