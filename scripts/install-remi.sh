#!/usr/bin/env bash
set -euo pipefail

# Remi agent installer.
#
# Usage:
#   curl -fsSL https://github.com/moesin-lab/Remi/releases/latest/download/install-remi.sh | bash
#
# Environment:
#   MULTIREMI_VERSION  Specific version to install, with or without leading "v".
#   MULTIREMI_BASE_URL Download from a self-hosted Remi server instead of GitHub.
#   MULTIREMI_RELEASE_REPO GitHub owner/repository used for releases. The older
#                          MULTIREMI_REPO name remains a compatibility fallback.
#   MULTIREMI_BIN_DIR  Directory for the remi binary. Defaults to
#                      /usr/local/bin, falling back to ~/.local/bin when sudo
#                      is unavailable.
#   MULTIREMI_INSTALL_ROOT  Version store; defaults to ~/.local/lib/remi.

REPO="${MULTIREMI_RELEASE_REPO:-${MULTIREMI_REPO:-moesin-lab/Remi}}"
VERSION="${MULTIREMI_VERSION:-latest}"
BIN_DIR="${MULTIREMI_BIN_DIR:-/usr/local/bin}"
INSTALL_ROOT="${MULTIREMI_INSTALL_ROOT:-$HOME/.local/lib/remi}"

info() { printf "==> %s\n" "$*"; }
ok() { printf "OK: %s\n" "$*"; }
fail() { printf "ERROR: %s\n" "$*" >&2; exit 1; }

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *) fail "Unsupported OS: $(uname -s). Multiremi supports macOS and Linux." ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) fail "Unsupported architecture: $(uname -m)." ;;
  esac
}

latest_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
}

selfhost_latest_version() {
  curl -fsSL "${MULTIREMI_BASE_URL%/}/api/remi/releases/latest/version" \
    | tr -d '[:space:]' \
    | sed 's/^v//'
}

install_binary() {
  local tag version url tmp

  if [ "$VERSION" = "latest" ]; then
    if [ -n "${MULTIREMI_BASE_URL:-}" ]; then
      version="$(selfhost_latest_version)"
      [ -n "$version" ] || fail "Could not determine latest Multiremi version from ${MULTIREMI_BASE_URL}."
      tag="v${version}"
    else
      tag="$(latest_tag)"
      [ -n "$tag" ] || fail "Could not determine latest release for ${REPO}."
    fi
  else
    tag="$VERSION"
    case "$tag" in v*) ;; *) tag="v${tag}" ;; esac
  fi
  version="${tag#v}"
  if [ -n "${MULTIREMI_BASE_URL:-}" ]; then
    url="${MULTIREMI_BASE_URL%/}/api/remi/releases/download/${tag}/remi-${version}-${OS}-${ARCH}.tar.gz"
  else
    url="https://github.com/${REPO}/releases/download/${tag}/remi-${version}-${OS}-${ARCH}.tar.gz"
  fi
  tmp="$(mktemp -d)"

  info "Downloading ${url}"
  curl -fsSL "$url" -o "$tmp/remi.tar.gz"
  # Match the content-addressed layout used by apps/remi/cli/update.ts.
  local digest snapshot staging current_version previous_dir entry
  digest="$(shasum -a 256 "$tmp/remi.tar.gz")"
  digest="${digest%% *}"
  snapshot="$INSTALL_ROOT/versions/${digest:0:8}"
  mkdir -p "$INSTALL_ROOT/versions"
  staging="$(mktemp -d "$INSTALL_ROOT/versions/.${digest:0:8}.XXXXXX")"
  trap 'rm -rf "$tmp" "${staging:-}"' EXIT
  # Only release-owned regular files may be extracted, never paths or links.
  while IFS= read -r entry; do
    case "$entry" in remi|remi-claude-agent-acp|runtime-bundle.json) ;; *) fail "Unexpected archive entry: $entry" ;; esac
  done < <(tar -tzf "$tmp/remi.tar.gz")
  if tar -tvzf "$tmp/remi.tar.gz" | grep -q '^[^-]'; then fail "Release archive contains non-regular entries"; fi
  tar -xzf "$tmp/remi.tar.gz" -C "$staging"
  [ -f "$staging/remi" ] || fail "Release archive has no remi"
  chmod +x "$staging/remi"
  [ "$("$staging/remi" --version | sed 's/^v//')" = "$version" ] || fail "Downloaded remi version mismatch"
  # Keep the adjacent bundle and wrapper together during preparation.
  local release_dir="$staging"
  chmod +x "$release_dir/remi"
  if [ -f "$release_dir/remi-claude-agent-acp" ]; then
    chmod +x "$release_dir/remi-claude-agent-acp"
  fi

  # Use the downloaded CLI's pins and adjacent wrapper. Failure stops before
  # replacing the running daemon. Older release archives remain installable.
  if [ -f "$release_dir/runtime-bundle.json" ]; then
    info "Preparing and verifying ACP and bundled agent runtimes"
    if ! "$release_dir/remi" runtime prepare; then
      rm -rf "$tmp"
      fail "Runtime preparation failed; the existing remi binary was not replaced."
    fi
  fi

  # Resolve the destination before saving the old executable or building launchers.
  if [ ! -d "$BIN_DIR" ]; then mkdir -p "$BIN_DIR" 2>/dev/null || true; fi
  if [ ! -w "$BIN_DIR" ] && ! command -v sudo >/dev/null 2>&1; then
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
  fi
  case "$INSTALL_ROOT:$BIN_DIR" in *$'\n'*) fail "Install paths must not contain newlines" ;; esac
  if [ -f "$BIN_DIR/remi" ]; then
    cp "$BIN_DIR/remi" "$staging/previous-launcher"
    if [ "$(head -c 2 "$BIN_DIR/remi")" != '#!' ]; then
      current_version="$("$BIN_DIR/remi" --version)"
      current_version="${current_version#v}"
      current_version="$(printf '%s' "$current_version" | sed 's/[^A-Za-z0-9._-]/-/g')"
      previous_dir="$INSTALL_ROOT/versions/previous-$current_version"
      if [ ! -e "$previous_dir" ]; then
        mkdir "$previous_dir"
        cp -p "$BIN_DIR/remi" "$previous_dir/remi"
      fi
    fi
  fi
  build_launcher "$BIN_DIR/remi" "$snapshot/remi" > "$staging/launcher"
  if [ -e "$snapshot" ]; then
    # A truncated digest collision must not silently reuse different bytes.
    for entry in remi remi-claude-agent-acp runtime-bundle.json; do
      if [ -e "$staging/$entry" ] || [ -e "$snapshot/$entry" ]; then
        cmp "$staging/$entry" "$snapshot/$entry" || fail "Snapshot collision: $snapshot"
      fi
    done
  else
    # Rename within the same filesystem. Keep staging until launchers are ready.
    mv "$staging" "$snapshot"
    staging="$(mktemp -d "$INSTALL_ROOT/versions/.launcher.XXXXXX")"
    cp "$snapshot/launcher" "$staging/launcher"
  fi
  if [ -f "$snapshot/remi-claude-agent-acp" ]; then
    build_launcher /dev/null "$snapshot/remi-claude-agent-acp" > "$staging/wrapper-launcher"
    install_file "$staging/wrapper-launcher" "remi-claude-agent-acp"
  fi
  # Commit last: failures above leave the currently selected CLI untouched.
  install_file "$staging/launcher" "remi"
  ok "Installed remi to ${BIN_DIR}/remi (snapshot ${snapshot})"

  rm -rf "$tmp" "$staging"
  trap - EXIT

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf "Note: add %s to PATH if your shell cannot find remi.\n" "$BIN_DIR" ;;
  esac
}

# Preserve shell setup and arguments, replacing only the last exec of remi.
# This is the same launcher grammar accepted by update.ts:buildLauncher.
build_launcher() {
  local current="$1" binary="$2" quoted line command index=-1 i=0
  local lines=() prefixes=() suffixes=()
  local generated_pattern='^([[:space:]]*exec[[:space:]]+)(.*)([[:space:]]+"\$@")$'
  quoted="$(printf '%s' "$binary" | sed "s/'/'\\\\''/g")"
  if [[ "$binary" =~ ^[A-Za-z0-9_/:=.,@%+-]+$ ]]; then
    quoted="$binary"
  else
    quoted="'$quoted'"
  fi
  local exec_pattern
  IFS= read -r exec_pattern <<'PATTERN'
^([[:space:]]*exec[[:space:]]+)("([^"]+)"|'([^']+)'|([^[:space:]]+))(.*)$
PATTERN
  if [ -f "$current" ] && [ "$(head -c 2 "$current")" = '#!' ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      lines[i]="$line"
      if [[ "$line" =~ $exec_pattern ]]; then
        command="${BASH_REMATCH[3]:-${BASH_REMATCH[4]:-${BASH_REMATCH[5]}}}"
        if [ "${command##*/}" = remi ]; then
          index=$i; prefixes[i]="${BASH_REMATCH[1]}"; suffixes[i]="${BASH_REMATCH[6]}"
        fi
      fi
      # Our quoted paths can contain shell-escaped apostrophes. Recognize the
      # generated launcher as well as update.ts's simple quoted exec grammar.
      if [[ "$line" =~ $generated_pattern ]]; then
        command="${BASH_REMATCH[2]}"
        if [[ "$command" == \'*'/remi'\' ]]; then
          index=$i; prefixes[i]="${BASH_REMATCH[1]}"; suffixes[i]="${BASH_REMATCH[3]}"
        fi
      fi
      i=$((i + 1))
    done < "$current"
    if [ "$index" -ge 0 ]; then
      lines[index]="${prefixes[index]}$quoted${suffixes[index]}"
      printf '%s\n' "${lines[@]}"
      return
    fi
  fi
  printf '#!/bin/sh\n# Remi stable launcher; versioned binaries make upgrades recoverable.\nexec %s "$@"\n' "$quoted"
}

install_file() {
  local src="$1" name="$2" destination
  # mktemp and rename in BIN_DIR keep replacement atomic even across mounts.
  if [ -w "$BIN_DIR" ]; then
    destination="$(mktemp "$BIN_DIR/.$name.XXXXXX")"
    if ! cp "$src" "$destination" || ! chmod 755 "$destination" || ! mv -f "$destination" "$BIN_DIR/$name"; then
      rm -f "$destination"
      return 1
    fi
  else
    destination="$(sudo mktemp "$BIN_DIR/.$name.XXXXXX")"
    if ! sudo cp "$src" "$destination" || ! sudo chmod 755 "$destination" || ! sudo mv -f "$destination" "$BIN_DIR/$name"; then
      sudo rm -f "$destination"
      return 1
    fi
  fi
}

detect_platform
install_binary

printf "\nNext step:\n"
printf "  remi setup --server <SERVER_URL> --workspace <WORKSPACE_ID> --token <YOUR_TOKEN> --start\n"
printf "\nAgent controls:\n"
printf "  remi daemon status\n"
printf "  remi daemon logs --follow\n"
printf "  remi daemon stop\n"
