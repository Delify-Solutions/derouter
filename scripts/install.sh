#!/usr/bin/env bash
# DeRouter Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Delify-Solutions/derouter/main/scripts/install.sh | sh
#
# Needs only curl: uv is bootstrapped if missing, and uv provisions a compatible
# Python itself (reusing a suitable system one, else downloading a managed build).
#
# To install from an unreleased branch, tag, or commit instead of the latest PyPI
# release, set DEROUTER_CLI_REF:
#   curl -fsSL https://raw.githubusercontent.com/Delify-Solutions/derouter/<branch>/scripts/install.sh | \
#     DEROUTER_CLI_REF=<branch> sh
#
# NOTE: set -e without pipefail for POSIX sh compatibility (dash on Ubuntu/Debian
# ignores the shebang when invoked as `sh` and does not support `pipefail`).
set -eu

# NOTE: before merging, this must stay as "derouter[proxy]" to install from PyPI.
# DEROUTER_CLI_REF opts into installing from a branch, tag, or commit instead (for
# example, to QA lite autoroute against an unreleased branch, which needs this proxy
# runtime, not the thin derouter[cli] install).
if [ -n "${DEROUTER_CLI_REF:-}" ]; then
  DEROUTER_PACKAGE="derouter[proxy] @ git+https://github.com/Delify-Solutions/derouter.git@${DEROUTER_CLI_REF}"
else
  DEROUTER_PACKAGE="derouter[proxy]"
fi
UV_VERSION="0.10.9"

# ── colours ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[38;2;78;186;101m'
  GREY='\033[38;2;153;153;153m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' GREY='' RESET=''
fi

info()    { printf "${GREY}  %s${RESET}\n" "$*"; }
success() { printf "${GREEN}  ✔ %s${RESET}\n" "$*"; }
header()  { printf "${BOLD}  %s${RESET}\n" "$*"; }
die()     { printf "\n  Error: %s\n\n" "$*" >&2; exit 1; }

# ── banner ─────────────────────────────────────────────────────────────────
echo ""
cat << 'EOF'
  ██╗     ██╗████████╗███████╗██╗     ██╗     ███╗   ███╗
  ██║     ██║╚══██╔══╝██╔════╝██║     ██║     ████╗ ████║
  ██║     ██║   ██║   █████╗  ██║     ██║     ██╔████╔██║
  ██║     ██║   ██║   ██╔══╝  ██║     ██║     ██║╚██╔╝██║
  ███████╗██║   ██║   ███████╗███████╗███████╗██║ ╚═╝ ██║
  ╚══════╝╚═╝   ╚═╝   ╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝
EOF
printf "  ${BOLD}DeRouter Installer${RESET}  ${GREY}— unified gateway for 100+ LLM providers${RESET}\n\n"

# ── OS detection ───────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)  PLATFORM="macOS ($ARCH)" ;;
  Linux)   PLATFORM="Linux ($ARCH)" ;;
  *)       die "Unsupported OS: $OS. DeRouter supports macOS and Linux." ;;
esac

info "Platform: $PLATFORM"

# ── uv detection / install ────────────────────────────────────────────────
UV_BIN=""
CURRENT_UV_VERSION=""
for candidate in uv "$HOME/.local/bin/uv"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    UV_BIN="$(command -v "$candidate")"
    break
  elif [ -x "$candidate" ]; then
    UV_BIN="$candidate"
    break
  fi
done

if [ -n "$UV_BIN" ]; then
  CURRENT_UV_VERSION="$("$UV_BIN" --version 2>/dev/null | awk '{print $2}' | head -1 || true)"
fi

if [ -z "$UV_BIN" ] || [ "${CURRENT_UV_VERSION:-}" != "$UV_VERSION" ]; then
  header "Installing uv…"
  if [ -n "${CURRENT_UV_VERSION:-}" ]; then
    info "Upgrading uv from ${CURRENT_UV_VERSION} to ${UV_VERSION}"
  fi
  curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_NO_MODIFY_PATH=1 sh \
    || die "uv installation failed. Try manually: curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh"
  UV_BIN="$HOME/.local/bin/uv"
fi

# ── install ────────────────────────────────────────────────────────────────
echo ""
if [ -n "${DEROUTER_CLI_REF:-}" ]; then
  header "Installing derouter[proxy] from ${DEROUTER_CLI_REF}…"
else
  header "Installing derouter[proxy]…"
fi
echo ""

# --python mirrors requires-python in pyproject.toml (keep in sync): uv selects the
# interpreter before resolving, so an unconstrained request accepts a too-old system
# Python (stock macOS ships 3.9) and fails resolution instead of downloading a
# managed one. --python-preference system still reuses a compatible system Python.
"$UV_BIN" tool install --python '>=3.10,<3.15' --python-preference system --force "${DEROUTER_PACKAGE}" \
  || die "uv tool install failed. Try manually: $UV_BIN tool install --python '>=3.10,<3.15' '${DEROUTER_PACKAGE}'"

# ── find the derouter binary installed by uv tool ───────────────────────────
SCRIPTS_DIR="$("$UV_BIN" tool dir --bin)"
DEROUTER_BIN="${SCRIPTS_DIR}/derouter"

if [ ! -x "$DEROUTER_BIN" ]; then
  die "derouter binary not found after install. Try: $UV_BIN tool install '${DEROUTER_PACKAGE}'"
fi

# ── success banner ─────────────────────────────────────────────────────────
echo ""
success "DeRouter installed"

installed_ver="$("$DEROUTER_BIN" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ -n "$installed_ver" ] && info "Version: $installed_ver"

# ── PATH hint ──────────────────────────────────────────────────────────────
if ! command -v derouter >/dev/null 2>&1; then
  info "Note: add derouter to your PATH:  export PATH=\"\$PATH:${SCRIPTS_DIR}\""
fi

# ── launch setup wizard ────────────────────────────────────────────────────
echo ""
printf "  ${BOLD}Run the interactive setup wizard?${RESET} ${GREY}(Y/n)${RESET}: "
# /dev/tty may be unavailable in Docker/CI — default to yes if it can't be read
answer=""
if [ -r /dev/tty ]; then
  read -r answer </dev/tty || answer=""
fi

if [ -z "$answer" ] || [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
  echo ""
  # Use /dev/tty for interactive input when available (stdin is a pipe from curl)
  if [ -r /dev/tty ]; then
    exec "$DEROUTER_BIN" --setup </dev/tty
  else
    exec "$DEROUTER_BIN" --setup
  fi
else
  echo ""
  header "Quick start:"
  echo ""
  info "  derouter --setup          # interactive wizard"
  info "  derouter --model gpt-4o   # single-model quickstart"
  echo ""
  info "Docs: https://router.delify.vn"
  echo ""
fi
