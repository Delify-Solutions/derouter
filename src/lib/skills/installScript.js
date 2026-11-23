// The one-line installer a customer pipes into sh:
//
//   curl -fsSL https://<host>/api/public/skills/install.sh | DEROUTER_KEY=<key> sh -s -- --all
//
// The script is public and carries no secret: it reads the customer's key from
// their environment (or a hidden prompt) and sends it as a header to the
// catalogue and file endpoints, which authenticate it (skillKey.js).
//
// It is POSIX sh with only curl as a dependency, wrapped in main() so a download
// cut short never executes half a script.

import { SKILL_RUNTIMES, SHARED_SKILLS_DIR, runtimeSkillsDir } from "./runtimes.js";
import {
  ENGINE_TARGETS,
  ENGINE_HOME_BASE,
  bundleTarballUrl,
  bundleRawFileUrl,
  NODE_MIN,
} from "./engineTargets.js";

// Only a plain http(s) origin is ever written into the script, because the
// value is placed inside single quotes.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

export function isSafeOrigin(origin) {
  return typeof origin === "string" && ORIGIN_RE.test(origin);
}

const TEMPLATE = String.raw`#!/bin/sh
# derouter skill installer. Installs the skills your account may use into the coding
# agents on this machine (Claude Code, Codex, Cursor, omp, dsh, …).
#
#   curl -fsSL __ORIGIN__/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- --all
#
# Options:
#   --all             install every skill in the catalogue, and every published
#                     bundle's engine (implies --engine)
#   --list            only list the catalogue
#   --bundle <slug>   install every skill in this bundle, plus its engine (implies
#                     --engine; repeatable for several bundles)
#   --target <names>  agent ids (comma list or repeated), e.g. claude,omp,dsh;
#                     default: every agent the skill supports that is on this machine
#   --copy            copy into each agent's folder instead of linking them to one
#                     shared copy (when a skill goes to several agents)
#   --dir <path>      install under <path>/<slug>/ instead of an agent's directory
#   --url <origin>    server address (default: the one this script came from)
#   <slug> ...        install only these skills
#   (nothing)         in a terminal: shows a numbered list and asks which to install
#                     (numbers or names, or "a" for all)
#
# The key is read from DEROUTER_KEY, or asked for without echo. It is never
# written to disk and never put on a command line.
set -eu
# No pathname expansion: every unquoted expansion below is a plain word list.
set -f

BASE="@{DEROUTER_URL:-__ORIGIN__}"
KEY="@{DEROUTER_KEY:-}"
RUNTIMES="__RUNTIME_IDS__"
ENGINE_TARGETS="__ENGINE_IDS__"
ENGINE_MCP="__ENGINE_MCP_IDS__"
ENGINE_BRIDGE="__ENGINE_BRIDGE_IDS__"
ENGINE_NONE="__ENGINE_NONE_IDS__"
ENGINE_HOME_BASE="__ENGINE_HOME_BASE__"
BUNDLE_SLUGS="__BUNDLE_SLUGS__"
NODE_MIN="__NODE_MIN__"
CANON="$HOME/__SHARED_DIR__"
COPY=0
# Where the choice is read from when no skill is named; the terminal, not stdin
# (stdin is this script when it is piped into sh).
TTY="@{DEROUTER_TTY:-/dev/tty}"

die() { printf 'Lỗi: %s\n' "$1" >&2; exit 1; }

# Escape a value so it can sit inside a double-quoted JS/TS string literal — used
# only to inject the omp bridge's real engine path (install_one_bundle_engine),
# never on anything that reaches a shell command line.
js_dq() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

usage() {
  cat <<'USAGE'
Dùng: curl -fsSL <địa-chỉ>/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- [tuỳ chọn] [slug ...]

  --all              cài mọi skill trong danh sách, kèm engine của mọi bundle đã
                     phát hành (tự bật --engine)
  --list             chỉ liệt kê, không cài
  --bundle <slug>    cài mọi skill trong bundle này, kèm engine (tự bật --engine;
                     dùng nhiều lần nếu muốn nhiều bundle)
  (không gì cả)      trong terminal: hiện danh sách đánh số và hỏi muốn cài cái nào
                     (số hoặc tên, "a" để cài tất cả)
  --target <tên>     id agent (nhiều tên cách nhau dấu phẩy), ví dụ claude,omp,dsh
                     mặc định: mọi agent skill hỗ trợ mà máy này đang có
  --copy             chép riêng vào từng agent, không liên kết chung một bản
  --dir <đường dẫn>  cài vào <đường dẫn>/<slug>/
  --url <địa chỉ>    địa chỉ máy chủ
USAGE
}

__RUNTIME_FUNCS__

# curl reads the Authorization header from a config on stdin, so the key never
# appears in the process list.
fetch() {
  # $1 = url, $2 = output file; prints the HTTP status.
  printf 'header = "Authorization: Bearer %s"\n' "$KEY" |
    curl -sS -K - -o "$2" -w '%{http_code}' "$1"
}

explain() {
  case "$1" in
    401) die "key không hợp lệ hoặc tài khoản không còn hoạt động" ;;
    404) die "không tìm thấy skill (đã gỡ hoặc chưa phát hành)" ;;
    429) die "thử sai key quá nhiều lần, thử lại sau ít phút" ;;
    *) die "máy chủ trả mã $1" ;;
  esac
}

# install_one <slug> <file> <runtime-or-dir-label> <destination root>
install_one() {
  i_slug="$1"; i_file="$2"; i_dest="$4/$1"
  mkdir -p "$i_dest" || die "không tạo được $i_dest"
  if [ -f "$i_dest/$i_file" ] && cmp -s "$WORK/$i_slug.md" "$i_dest/$i_file"; then
    i_state="đã là bản mới nhất"
  elif [ -f "$i_dest/$i_file" ]; then
    i_state="đã cập nhật"
  else
    i_state="đã cài"
  fi
  cp "$WORK/$i_slug.md" "$i_dest/$i_file.tmp" && mv -f "$i_dest/$i_file.tmp" "$i_dest/$i_file" || die "không ghi được $i_dest/$i_file"
  printf '%s [%s]: %s -> %s/%s\n' "$i_slug" "$3" "$i_state" "$i_dest" "$i_file"
  installed=$((installed + 1))
}

# link_one <slug> <file> <agents> <destination root>: point <root>/<slug> at the shared
# copy. A real folder already there (an earlier install) is updated in place rather
# than replaced, and so is a link to somewhere else (the customer's own, say); only our
# own link or a dangling one is (re)made. A filesystem that cannot link gets a copy.
link_one() {
  l_dest="$4/$1"
  if [ -L "$l_dest" ]; then
    if [ "$(readlink "$l_dest" 2>/dev/null)" != "$CANON/$1" ] && [ -e "$l_dest" ]; then
      install_one "$1" "$2" "$3" "$4"
      return 0
    fi
  elif [ -e "$l_dest" ]; then
    install_one "$1" "$2" "$3" "$4"
    return 0
  fi
  if mkdir -p "$4" 2>/dev/null && ln -sfn "$CANON/$1" "$l_dest" 2>/dev/null; then
    printf '%s [%s]: đã liên kết -> %s\n' "$1" "$3" "$l_dest"
    installed=$((installed + 1))
  else
    install_one "$1" "$2" "$3" "$4"
  fi
}

# --- engine ------------------------------------------------------------------
#
# The skills call tools that live in a Node MCP server — one per bundle a customer
# has skills from. Without it a skill loads, reads a tool name, finds nothing, and
# stops. --engine fetches every such bundle's engine and registers it with each
# agent that can take one.
#
# omp has no MCP client, so it gets a bridge extension instead; dsh owns its own copy
# and is skipped. Both facts live in ENGINE_MCP / ENGINE_BRIDGE / ENGINE_NONE above.
# BUNDLE_SLUGS and the three bundle_*_for() tables below are rendered per bundle by
# installScript.js — never hand-written, and empty when no bundle is published yet.

engine_path_for() {
  case "$1" in
__ENGINE_PATH_CASES__
    *) printf '%s' "" ;;
  esac
}

engine_key_for() {
  case "$1" in
__ENGINE_KEY_CASES__
    *) printf '%s' "" ;;
  esac
}

engine_format_for() {
  case "$1" in
__ENGINE_FORMAT_CASES__
    *) printf '%s' "json" ;;
  esac
}

bundle_tarball_for() {
  case "$1" in
__BUNDLE_TARBALL_CASES__
    *) printf '%s' "" ;;
  esac
}

bundle_bridge_for() {
  case "$1" in
__BUNDLE_BRIDGE_CASES__
    *) printf '%s' "" ;;
  esac
}

# The bundle's own installer entrypoint, relative to its unpacked tree — "" when
# the bundle has none.
bundle_installer_for() {
  case "$1" in
__BUNDLE_INSTALLER_CASES__
    *) printf '%s' "" ;;
  esac
}

# A node that has node:sqlite. The engine cannot run on anything older, and an
# agent's bundled runtime (Bun, Electron) is not a substitute.
node_for_engine() {
  # set -u: REDTEAM_NODE and the rest may be unset, so default them here.
  for candidate in "@{REDTEAM_NODE:-}" "$(command -v node 2>/dev/null || true)" \
                   /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>Number(process.argv[1].split(".")[0])||(a===Number(process.argv[1].split(".")[0])&&b>=Number(process.argv[1].split(".")[1]))?0:1)' "$NODE_MIN" 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Write the MCP registration for one agent, for one bundle. Merges into an
# existing config rather than replacing it: whatever else is already registered
# there, including another bundle, must survive — each bundle gets its own key,
# named after its slug.
register_mcp() {
  r_agent="$1"; r_key="$2"; r_config="$3"; r_node="$4"; r_server="$5"; r_name="$6"
  r_format="$(engine_format_for "$r_agent")"
  mkdir -p "$(dirname "$r_config")" 2>/dev/null || true
  # A TOML config (Codex) and a JSON one need different writers. Handing a TOML file
  # to JSON.parse throws, and the catch below starts from {} — which used to replace
  # the customer's entire config with one JSON object and stop codex from booting.
  if [ "$r_format" = "toml" ]; then
    register_mcp_toml "$r_config" "$r_key" "$r_node" "$r_server" "$r_name" && {
      printf 'engine %s [%s]: đã đăng ký MCP -> %s\n' "$r_name" "$r_agent" "$r_config"
      return 0
    }
    printf 'engine %s [%s]: KHÔNG ghi được %s\n' "$r_name" "$r_agent" "$r_config" >&2
    return 1
  fi
  if [ "$r_format" = "opencode" ]; then
    register_mcp_opencode "$r_key" "$r_config" "$r_node" "$r_server" "$r_name" && {
      printf 'engine %s [%s]: đã đăng ký MCP -> %s\n' "$r_name" "$r_agent" "$r_config"
      return 0
    }
    printf 'engine %s [%s]: KHÔNG ghi được %s\n' "$r_name" "$r_agent" "$r_config" >&2
    return 1
  fi
  if "$r_node" -e '
const fs = require("fs");
const [configPath, agent, keyName, nodePath, serverPath, serverName] = process.argv.slice(1);
let raw = "";
try { raw = fs.readFileSync(configPath, "utf8"); } catch { raw = ""; }
let data = {};
if (raw.trim() !== "") {
  try {
    data = JSON.parse(raw);
  } catch {
    // Never overwrite a file we cannot read: it belongs to the agent, not to us.
    console.error("refusing to rewrite an unreadable config: " + configPath);
    process.exit(1);
  }
}
// amp nests its key ("amp.mcpServers"); everything else is top level.
const parts = keyName.split(".");
let holder = data;
for (const part of parts.slice(0, -1)) {
  if (!holder[part] || typeof holder[part] !== "object") holder[part] = {};
  holder = holder[part];
}
const leaf = parts[parts.length - 1];
if (!holder[leaf] || typeof holder[leaf] !== "object") holder[leaf] = {};
holder[leaf][serverName] = {
  command: nodePath,
  args: [serverPath],
  env: { DSH_HOME: process.env.DSH_HOME || (process.env.HOME + "/.dsh") },
};
fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
' "$r_config" "$r_agent" "$r_key" "$r_node" "$r_server" "$r_name" 2>/dev/null; then
    printf 'engine %s [%s]: đã đăng ký MCP -> %s\n' "$r_name" "$r_agent" "$r_config"
  else
    printf 'engine %s [%s]: KHÔNG ghi được %s\n' "$r_name" "$r_agent" "$r_config" >&2
    return 1
  fi
}

# Append an [mcp_servers.<name>] table to a TOML config. Appending rather than
# rewriting: TOML has no comment-preserving parser in Node's standard library, and a
# file with hooks and trust state in it is the agent's, not ours to reflow. A table
# with the same name already there is left alone (the entry points at the same
# engine path anyway), so running the installer twice does not duplicate it.
register_mcp_toml() {
  t_config="$1"; t_key="$2"; t_node="$3"; t_server="$4"; t_name="$5"
  # A fixed string, not a regex: the header is written by us, so there is nothing to
  # pattern-match, and BRE/ERE differences across grep builds are a needless risk.
  if grep -qF "[@{t_key}.\"@{t_name}\"]" "$t_config" 2>/dev/null; then
    return 0
  fi
  # A header appended straight after the last line needs the blank line TOML wants.
  [ -s "$t_config" ] && printf '\n' >>"$t_config"
  {
    printf '[%s."%s"]\n' "$t_key" "$t_name"
    printf 'command = "%s"\n' "$t_node"
    printf 'args = ["%s"]\n' "$t_server"
    printf 'env = { DSH_HOME = "%s" }\n' "@{DSH_HOME:-$HOME/.dsh}"
  } >>"$t_config"
}

# OpenCode's own schema (opencode.ai/config.json) rejects the plain command/args/env
# shape every other json target takes — additionalProperties: false throughout, a
# required "type" discriminator, command as one array (no separate args), and the env
# field spelled "environment". Its own key nests two levels (mcp.servers.<name>), the
# same split("." ) walk the generic writer uses, just with a different leaf shape.
register_mcp_opencode() {
  o_key="$1"; o_config="$2"; o_node="$3"; o_server="$4"; o_name="$5"
  "$o_node" -e '
const fs = require("fs");
const [configPath, keyName, nodePath, serverPath, serverName] = process.argv.slice(1);
let raw = "";
try { raw = fs.readFileSync(configPath, "utf8"); } catch { raw = ""; }
let data = {};
if (raw.trim() !== "") {
  try {
    data = JSON.parse(raw);
  } catch {
    // opencode.json(c) allows comments/trailing commas the agent itself wrote;
    // plain JSON.parse cannot tell a real syntax error from those, so either way
    // this file is never ours to rewrite blind.
    console.error("refusing to rewrite an unreadable config: " + configPath);
    process.exit(1);
  }
}
const parts = keyName.split(".");
let holder = data;
for (const part of parts.slice(0, -1)) {
  if (!holder[part] || typeof holder[part] !== "object") holder[part] = {};
  holder = holder[part];
}
const leaf = parts[parts.length - 1];
if (!holder[leaf] || typeof holder[leaf] !== "object") holder[leaf] = {};
holder[leaf][serverName] = {
  type: "local",
  command: [nodePath, serverPath],
  environment: { DSH_HOME: process.env.DSH_HOME || (process.env.HOME + "/.dsh") },
};
fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
' "$o_config" "$o_key" "$o_node" "$o_server" "$o_name" 2>/dev/null
}

# Fetch and unpack one bundle's engine, once. Sets ENGINE_SERVER (its mcp-server.mjs
# path) and ENGINE_ROOT (its unpack root) on success. A fetch problem is only a
# warning, the script is never stopped over it: one bad bundle must not stop a
# customer's other bundles, or the skills this run already installed, from working.
install_engine_source() {
  b_slug="$1"
  e_root="$HOME/$ENGINE_HOME_BASE/$b_slug"
  e_server="$e_root/lib/mcp-server.mjs"
  ENGINE_SERVER=""; ENGINE_ROOT=""
  if [ -f "$e_server" ]; then
    # Update is how you refresh: the bundle is fetched fresh, so honour the flag
    # rather than asking the customer to guess a second switch.
    if [ "$UPDATE_ENGINE" = "1" ]; then
      printf 'engine %s: cập nhật %s\n' "$b_slug" "$e_root"
    else
      printf 'engine %s: đã có ở %s (--engine-update để làm mới)\n' "$b_slug" "$e_root"
      ENGINE_SERVER="$e_server"; ENGINE_ROOT="$e_root"
      return 0
    fi
  fi
  e_tarball="$(bundle_tarball_for "$b_slug")"
  if [ -z "$e_tarball" ]; then
    printf 'engine %s: không xác định được nguồn, bỏ qua\n' "$b_slug" >&2
    return 1
  fi
  e_tar="$WORK/engine-$b_slug.tar.gz"
  printf 'engine %s: tải %s\n' "$b_slug" "$e_tarball"
  code="$(curl -sSL -o "$e_tar" -w '%{http_code}' "$e_tarball")" || {
    printf 'engine %s: không tải được engine\n' "$b_slug" >&2
    return 1
  }
  if [ "$code" != "200" ]; then
    printf 'engine %s: không tải được engine (HTTP %s)\n' "$b_slug" "$code" >&2
    return 1
  fi
  e_tmp="$WORK/engine-unpack-$b_slug"
  mkdir -p "$e_tmp" || { printf 'engine %s: không tạo được thư mục giải nén\n' "$b_slug" >&2; return 1; }
  # Strip the single top-level directory the tarball carries.
  if ! tar -xzf "$e_tar" -C "$e_tmp" --strip-components=1 2>/dev/null; then
    printf 'engine %s: không giải nén được (cần tar)\n' "$b_slug" >&2
    return 1
  fi
  if [ ! -f "$e_tmp/lib/mcp-server.mjs" ]; then
    printf 'engine %s: gói engine thiếu lib/mcp-server.mjs\n' "$b_slug" >&2
    return 1
  fi
  mkdir -p "$e_root" || { printf 'engine %s: không tạo được %s\n' "$b_slug" "$e_root" >&2; return 1; }
  if ! cp -R "$e_tmp/." "$e_root/"; then
    printf 'engine %s: không chép được vào %s\n' "$b_slug" "$e_root" >&2
    return 1
  fi
  printf 'engine %s: đã cài vào %s\n' "$b_slug" "$e_root"
  ENGINE_SERVER="$e_root/lib/mcp-server.mjs"; ENGINE_ROOT="$e_root"
}

# Run a bundle's own installer entrypoint, if it has one and it exists in the
# unpacked tree, so the agent presets and orchestrating command that repository's
# own installer produces land next to the engine — never re-derived here
# (design.md). A missing entrypoint is skipped silently; a failing one is a
# warning, never a stopped install: the skills and MCP registration this run
# already did must stand.
#
# Agent presets and a slash/orchestrating command are not a Claude Code
# privilege — rea_policy's own install.mjs, for one, writes them for omp and
# Codex too, into each agent's own folder, given --agent <id>. This installer
# does not know which ids any given bundle's own installer recognises, so each
# wanted agent is tried on its own, never as one joined --agent list: a bundle
# that has never heard of one id this run wanted (dsh and opencode, for
# rea_policy today) must not cost every OTHER agent its presets too — only the
# whole list, tried together, risked that. An installer with no --agent support
# at all fails every one of those tries the same way, so it gets one last bare
# (no arguments) attempt — today's one guaranteed behaviour — only when claude
# is among the wanted agents, since that is the one id every version of
# install.mjs is known to default to.
run_bundle_installer() {
  rb_slug="$1"; rb_root="$2"; rb_node="$3"
  rb_entry="$(bundle_installer_for "$rb_slug")"
  [ -n "$rb_entry" ] || return 0

  if [ -n "$DIR" ]; then
    printf 'engine %s: bỏ qua cài agent/lệnh (đang dùng --dir, không phải thư mục cài mặc định)\n' "$rb_slug"
    return 0
  fi

  rb_file="$rb_root/$rb_entry"
  [ -f "$rb_file" ] || return 0

  rb_ok=""
  for rb_rt in $e_wanted; do
    if "$rb_node" "$rb_file" --agent "$rb_rt" >/dev/null 2>&1; then
      rb_ok="$rb_ok $rb_rt"
    fi
  done
  rb_ok="@{rb_ok# }"
  if [ -n "$rb_ok" ]; then
    printf 'engine %s [%s]: đã chạy %s (agent + lệnh)\n' "$rb_slug" "$(printf '%s' "$rb_ok" | tr ' ' ',')" "$rb_entry"
    return 0
  fi

  case " $e_wanted " in
    *" claude "*) ;;
    *) printf 'engine %s: %s không hỗ trợ agent nào đã chọn, bỏ qua (skill + MCP vẫn hoạt động)\n' "$rb_slug" "$rb_entry" >&2; return 0 ;;
  esac

  if "$rb_node" "$rb_file" >/dev/null 2>&1; then
    printf 'engine %s [claude]: đã chạy %s (agent + lệnh; agent khác không được bundle này nhận cùng lúc)\n' "$rb_slug" "$rb_entry"
  else
    printf 'engine %s [claude]: %s thoát lỗi, bỏ qua (skill + MCP vẫn hoạt động)\n' "$rb_slug" "$rb_entry" >&2
  fi
}

# Install one bundle's engine: fetch + unpack, register with every wanted agent,
# then (Claude Code only) run its own installer.
install_one_bundle_engine() {
  b_slug="$1"
  install_engine_source "$b_slug" || return 0
  [ -n "$ENGINE_SERVER" ] || return 0

  for e_rt in $e_wanted; do
    case " $ENGINE_MCP " in
      *" $e_rt "*)
        register_mcp "$e_rt" "$(engine_key_for "$e_rt")" "$(engine_path_for "$e_rt")" "$e_node" "$ENGINE_SERVER" "$b_slug" || true
        ;;
    esac
    case " $ENGINE_BRIDGE " in
      *" $e_rt "*)
        e_bridge="$(home_for "$e_rt")/agent/extensions/$b_slug-rt-engine.ts"
        mkdir -p "$(dirname "$e_bridge")" 2>/dev/null || true
        e_src="$ENGINE_ROOT/omp/rt-engine.ts"
        # The bundle normally carries the bridge. A tarball built before it existed
        # (a host cache, say) does not, so fall back to fetching the one file
        # rather than leaving omp with skills and no tools.
        if [ ! -f "$e_src" ]; then
          e_url="$(bundle_bridge_for "$b_slug")"
          if [ -n "$e_url" ]; then
            curl -sSL -o "$WORK/bridge-$b_slug.ts" "$e_url" 2>/dev/null && e_src="$WORK/bridge-$b_slug.ts"
          fi
        fi
        if [ -f "$e_src" ]; then
          if cp "$e_src" "$e_bridge"; then
            # The bridge only knows its own get.sh's single ~/rt-claude layout (its
            # own header comment); our bundles live one per slug under
            # ~/$ENGINE_HOME_BASE instead. Override enginePath() itself, not the
            # env var it also reads, so a second bundle's bridge, loaded into the
            # same omp process, never races this one over one process-wide variable.
            printf '\nenginePath = function enginePath() { return "%s" }\n' "$(js_dq "$ENGINE_SERVER")" >>"$e_bridge"
            printf 'engine %s [%s]: đã cài bridge -> %s\n' "$b_slug" "$e_rt" "$e_bridge"
          else
            printf 'engine %s [%s]: không ghi được bridge\n' "$b_slug" "$e_rt" >&2
          fi
        else
          printf 'engine %s [%s]: không lấy được bridge (bỏ qua)\n' "$b_slug" "$e_rt" >&2
        fi
        ;;
    esac
  done

  run_bundle_installer "$b_slug" "$ENGINE_ROOT" "$e_node"
}

install_engine() {
  if [ -z "$(printf '%s' "$BUNDLE_SLUGS" | tr -d ' ')" ]; then
    printf 'engine: chưa có bundle nào được phát hành, không có gì để cài\n' >&2
    return 0
  fi
  e_node="$(node_for_engine)" || die "cần Node >= $NODE_MIN cho engine (node:sqlite). Cài Node rồi thử lại, hoặc bỏ --engine."
  printf 'engine: node %s (%s)\n' "$("$e_node" -v 2>/dev/null)" "$e_node"

  # A --target name can be a real skill runtime (runtimes.js) that the engine has no
  # registration path for at all yet (it installs skills fine, just no tools): say so
  # plainly instead of leaving it looking like the install silently did nothing.
  if [ -n "$TARGETS" ]; then
    for t_req in $(printf '%s' "$TARGETS" | tr ',' ' '); do
      case " $ENGINE_TARGETS " in
        *" $t_req "*) ;;
        *) printf 'engine [%s]: agent này chưa có engine (chỉ cài được skill dạng văn bản)\n' "$t_req" >&2 ;;
      esac
    done
  fi

  # Which agents to register: those asked for by --target, else those installed here.
  e_wanted=""
  for e_rt in $ENGINE_MCP $ENGINE_BRIDGE; do
    if [ -n "$TARGETS" ]; then
      case ",$TARGETS" in *",$e_rt,"*) e_wanted="$e_wanted $e_rt" ;; esac
    else
      [ -d "$(home_for "$e_rt")" ] && e_wanted="$e_wanted $e_rt"
    fi
  done
  [ -n "$(printf '%s' "$e_wanted" | tr -d ' ')" ] || {
    printf 'engine: chưa thấy agent nào trên máy. Đăng ký xong rồi chạy lại với --target claude (hoặc codex, omp…).\n' >&2
    return 0
  }

  for e_rt in $ENGINE_NONE; do
    case " $e_wanted " in
      *" $e_rt "*) printf 'engine [%s]: agent này tự quản engine riêng, bỏ qua\n' "$e_rt" ;;
    esac
  done

  for b_slug in $BUNDLE_SLUGS; do
    install_one_bundle_engine "$b_slug"
  done

  printf 'engine: xong. Mở lại phiên agent; kiểm tra bằng cách liệt kê tool redteam_*.\n'
}

# place_skill <slug> <file>: write the skill to every place in $WORK/places (one
# "folder<TAB>agent" per line). Agents that read the same folder share one write. With
# several different folders, one canonical copy is written and the others link to it,
# so an update touches a single folder; --copy writes each folder separately.
place_skill() {
  awk -F '\t' '{ if (!($1 in names)) { order[++n] = $1; names[$1] = $2 } else { names[$1] = names[$1] "," $2 } }
               END { for (i = 1; i <= n; i++) printf "%s\t%s\n", order[i], names[order[i]] }' "$WORK/places" >"$WORK/groups"
  p_count="$(wc -l <"$WORK/groups" | tr -d ' ')"
  if [ "$COPY" = "1" ] || [ "$p_count" -le 1 ]; then
    while IFS="$(printf '\t')" read -r p_dir p_names; do
      install_one "$1" "$2" "$p_names" "$p_dir"
    done <"$WORK/groups"
    return 0
  fi
  p_canon_names="$(awk -F '\t' -v c="$CANON" '$1 == c { print $2 }' "$WORK/groups")"
  install_one "$1" "$2" "@{p_canon_names:-chung}" "$CANON"
  while IFS="$(printf '\t')" read -r p_dir p_names; do
    if [ "$p_dir" != "$CANON" ]; then link_one "$1" "$2" "$p_names" "$p_dir"; fi
  done <"$WORK/groups"
}

main() {
  command -v curl >/dev/null 2>&1 || die "cần có curl"

  ALL=0; LIST=0; TARGETS=""; DIR=""; SLUGS=""; BUNDLES=""; WITH_ENGINE=0; ENGINE_ONLY=0; UPDATE_ENGINE=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) ALL=1; WITH_ENGINE=1 ;;
      --list) LIST=1 ;;
      --bundle) [ $# -ge 2 ] || die "--bundle cần một giá trị"; BUNDLES="$BUNDLES,$2"; WITH_ENGINE=1; shift ;;
      --target) [ $# -ge 2 ] || die "--target cần một giá trị"; TARGETS="$TARGETS,$2"; shift ;;
      --copy) COPY=1 ;;
      --engine) WITH_ENGINE=1 ;;
      --engine-only) WITH_ENGINE=1; ENGINE_ONLY=1 ;;
      --engine-update) WITH_ENGINE=1; UPDATE_ENGINE=1 ;;
      --dir) [ $# -ge 2 ] || die "--dir cần một giá trị"; DIR="$2"; shift ;;
      --url) [ $# -ge 2 ] || die "--url cần một giá trị"; BASE="$2"; shift ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; die "tuỳ chọn không hợp lệ: $1" ;;
      *) SLUGS="$SLUGS $1" ;;
    esac
    shift
  done

  [ -n "$BASE" ] || die "không biết địa chỉ máy chủ, thêm --url https://..."
  # "http://127.0.0.1:1@evil.example" looks like loopback but connects to evil.example.
  case "$BASE" in *@*) die "địa chỉ máy chủ không được chứa @" ;; esac
  # The key travels in a header, so only HTTPS (or this machine) may receive it.
  case "$BASE" in
    https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|"http://[::1]"|"http://[::1]:"*) ;;
    *) die "địa chỉ máy chủ phải là https:// (không gửi key qua http)" ;;
  esac
  # --target: every name must be a known agent; keep a ",a,b," form for matching.
  if [ -n "$TARGETS" ]; then
    # Commas and spaces both separate names; "--target ''" is an error, not "everything".
    TARGETS="$(printf '%s' "$TARGETS" | tr ' ' ',' | tr -s ',')"
    [ -n "$(printf '%s' "$TARGETS" | tr -d ',')" ] || die "--target cần ít nhất một tên agent"
    for name in $(printf '%s' "$TARGETS" | tr ',' ' '); do
      case " $RUNTIMES " in *" $name "*) ;; *) die "--target không có agent \"$name\" (có: $RUNTIMES)" ;; esac
    done
    TARGETS="$TARGETS,"
  fi

  if [ -z "$KEY" ] && ( : </dev/tty ) 2>/dev/null; then
    printf 'API key: ' >/dev/tty
    stty -echo </dev/tty 2>/dev/null || true
    IFS= read -r KEY </dev/tty || true
    stty echo </dev/tty 2>/dev/null || true
    printf '\n' >/dev/tty
  fi
  [ -n "$KEY" ] || die "thiếu API key (đặt DEROUTER_KEY=...)"
  # The key goes into a curl config line, so refuse anything that could break out of it.
  case "$KEY" in *[!A-Za-z0-9._~+/=-]*) die "API key có ký tự không hợp lệ" ;; esac

  WORK="$(mktemp -d "@{TMPDIR:-/tmp}/derouter-skills.XXXXXX")" || die "không tạo được thư mục tạm"
  trap 'rm -rf "$WORK"' EXIT INT TERM

  # --engine-only means exactly that: no catalogue fetch, no skill writes.
  if [ "$ENGINE_ONLY" = "1" ]; then
    install_engine
    return 0
  fi

  code="$(fetch "$BASE/api/public/skills/catalog" "$WORK/catalog")" || die "không kết nối được $BASE"
  [ "$code" = "200" ] || explain "$code"
  [ -s "$WORK/catalog" ] || die "chưa có skill nào được phát hành cho tài khoản này"

  # --bundle <slug>: every skill the catalogue tags with that bundle in its 6th
  # column, instead of the customer naming each one. Unknown name (or an empty
  # bundle) is an error, not a silent no-op.
  if [ -n "$BUNDLES" ]; then
    for b_want in $(printf '%s' "$BUNDLES" | tr ',' ' '); do
      b_found=0
      while IFS="$(printf '\t')" read -r slug file version target name bundle; do
        [ -n "$slug" ] || continue
        [ "$bundle" = "$b_want" ] || continue
        b_found=1
        case " $SLUGS " in *" $slug "*) ;; *) SLUGS="$SLUGS $slug" ;; esac
      done <"$WORK/catalog"
      [ "$b_found" = "1" ] || die "không có bundle \"$b_want\" (hoặc chưa có skill nào trong đó)"
    done
  fi

  # Nothing named and a terminal to ask: show the catalogue numbered and let the
  # customer pick some, or all.
  if [ "$LIST" = "0" ] && [ "$ALL" = "0" ] && [ -z "$SLUGS" ] && ( : <"$TTY" ) 2>/dev/null; then
    count=0
    printf '%s\n' "Skill bạn có thể cài:" >&2
    while IFS="$(printf '\t')" read -r slug file version target name bundle; do
      [ -n "$slug" ] || continue
      count=$((count + 1))
      shown="$target"; [ "$shown" != "all" ] || shown="mọi agent"
      printf '%4d) %-30s %-20s %s\n' "$count" "$slug" "$shown" "$name" >&2
    done <"$WORK/catalog"
    printf '\nChọn số hoặc tên (cách nhau bằng dấu cách), "a" để cài tất cả, Enter để thoát: ' >&2
    choice=""
    IFS= read -r choice <"$TTY" || true
    choice="$(printf '%s' "$choice" | tr ',' ' ')"
    if [ -z "$(printf '%s' "$choice" | tr -d ' ')" ]; then
      printf '%s\n' "Không chọn skill nào." >&2
      return 0
    fi
    for token in $choice; do
      case "$token" in
        a|A|all|ALL) ALL=1; WITH_ENGINE=1 ;;
        *[!0-9]*)
          cut -f1 "$WORK/catalog" | grep -Fxq -- "$token" || die "không có skill \"$token\" trong danh sách"
          SLUGS="$SLUGS $token" ;;
        *)
          [ "$token" -ge 1 ] 2>/dev/null && [ "$token" -le "$count" ] || die "không có số $token trong danh sách (1-$count)"
          SLUGS="$SLUGS $(sed -n "@{token}p" "$WORK/catalog" | cut -f1)" ;;
      esac
    done
  fi

  if [ "$LIST" = "1" ] || { [ "$ALL" = "0" ] && [ -z "$SLUGS" ]; }; then
    printf '%-32s %-22s %-8s %s\n' SLUG AGENT VERSION TÊN
    while IFS="$(printf '\t')" read -r slug file version target name bundle; do
      [ -n "$slug" ] || continue
      shown="$target"; [ "$shown" != "all" ] || shown="mọi agent"
      printf '%-32s %-22s %-8s %s\n' "$slug" "$shown" "$version" "$name"
    done <"$WORK/catalog"
    if [ "$LIST" = "0" ]; then
      printf '\nChọn skill: thêm tên skill phía sau, hoặc --all để cài tất cả.\n'
    fi
    return 0
  fi

  # Check every line of the catalogue before writing anything: one bad entry
  # means the response cannot be trusted, so nothing is installed.
  while IFS="$(printf '\t')" read -r slug file version target name bundle; do
    [ -n "$slug" ] || continue
    case "$slug" in ""|*[!a-z0-9-]*|-*|*-) die "slug không hợp lệ từ máy chủ: $slug" ;; esac
    case "$file" in ""|*[!A-Za-z0-9._-]*|.*) die "tên file không hợp lệ từ máy chủ: $file" ;; esac
    case "$target" in ""|*[!a-z,]*|,*|*,|*,,*) die "danh sách agent không hợp lệ từ máy chủ: $target" ;; esac
    case "$bundle" in ""|-) ;; *[!a-z0-9-]*|-*|*-) die "bundle không hợp lệ từ máy chủ: $bundle" ;; esac
    # "all" or agents this script knows: the name picks a folder from the table above.
    if [ "$target" != "all" ]; then
      for name in $(printf '%s' "$target" | tr ',' ' '); do
        case " $RUNTIMES " in *" $name "*) ;; *) die "agent không hợp lệ từ máy chủ: $name" ;; esac
      done
    fi
  done <"$WORK/catalog"

  for want in $SLUGS; do
    cut -f1 "$WORK/catalog" | grep -Fxq -- "$want" || die "không có skill \"$want\" trong danh sách (dùng --list để xem)"
  done

  installed=0
  while IFS="$(printf '\t')" read -r slug file version target name bundle; do
    [ -n "$slug" ] || continue
    if [ "$ALL" = "0" ]; then
      case " $SLUGS " in *" $slug "*) ;; *) continue ;; esac
    fi

    code="$(fetch "$BASE/api/public/skills/file/$slug" "$WORK/$slug.md")" || die "không kết nối được $BASE"
    [ "$code" = "200" ] || explain "$code"
    [ -s "$WORK/$slug.md" ] || die "skill $slug rỗng"

    if [ -n "$DIR" ]; then
      install_one "$slug" "$file" "thư mục" "$DIR"
      continue
    fi

    # Agents this skill supports, narrowed to --target, or else to the ones that
    # exist on this machine.
    if [ "$target" = "all" ]; then supported="$RUNTIMES"; else supported="$(printf '%s' "$target" | tr ',' ' ')"; fi
    : >"$WORK/places"
    for rt in $RUNTIMES; do
      case " $supported " in *" $rt "*) ;; *) continue ;; esac
      if [ -n "$TARGETS" ]; then
        case ",$TARGETS" in *",$rt,"*) ;; *) continue ;; esac
      elif [ ! -d "$(home_for "$rt")" ]; then
        continue
      fi
      printf '%s\t%s\n' "$(dir_for "$rt")" "$rt" >>"$WORK/places"
    done

    if [ ! -s "$WORK/places" ]; then
      if [ -n "$TARGETS" ]; then
        printf '%s: bỏ qua (skill dành cho %s, không có trong --target)\n' "$slug" "$target"
        continue
      fi
      # No supported agent found here: put it where the skill's first agent will look.
      first="$(printf '%s' "$supported" | cut -d' ' -f1)"
      printf '%s: chưa thấy agent nào trên máy, cài cho %s\n' "$slug" "$first"
      printf '%s\t%s\n' "$(dir_for "$first")" "$first" >"$WORK/places"
    fi
    place_skill "$slug" "$file"
  done <"$WORK/catalog"

  if [ "$WITH_ENGINE" = "1" ]; then
    install_engine
  fi

  printf '\nXong: %s bản cài. Mở lại phiên của agent (Claude Code, Codex, omp, dsh…) để nạp skill mới.\n' "$installed"
}

main "$@"
`;

const SAFE_ID = /^[a-z]+$/;
// A relative path of plain names: no leading slash, no empty or dot-dot segment.
const SAFE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const SAFE_ENV = /^[A-Z][A-Z0-9_]*$/;

/**
 * The shell for the agent table: the id list and the two lookups that turn an id into
 * the folder that marks the agent as installed and the folder it reads skills from.
 * Everything comes from the registry and is checked against a strict pattern, because
 * these values are written into a script customers run.
 */
export function runtimeShell() {
  for (const runtime of SKILL_RUNTIMES) {
    const ok =
      SAFE_ID.test(runtime.id) &&
      SAFE_PATH.test(runtime.home) &&
      SAFE_PATH.test(runtimeSkillsDir(runtime)) &&
      (!runtime.homeEnv || SAFE_ENV.test(runtime.homeEnv)) &&
      (!runtime.xdg || SAFE_PATH.test(runtime.xdg)) &&
      (!runtime.xdgSkills || SAFE_PATH.test(runtime.xdgSkills));
    if (!ok) throw new Error(`runtime "${runtime.id}" cannot be written into the installer`);
  }
  // `@{` is `${` — see buildInstallScript.
  const xdg = "@{XDG_CONFIG_HOME:-$HOME/.config}";
  const homeOf = (r) => {
    if (r.xdg) return xdg + "/" + r.xdg;
    return r.homeEnv ? "@{" + r.homeEnv + ":-$HOME/" + r.home + "}" : "$HOME/" + r.home;
  };
  const dirOf = (r) => {
    if (r.xdgSkills) return xdg + "/" + r.xdgSkills;
    return r.skills ? "$HOME/" + r.skills : homeOf(r) + "/skills";
  };
  const cases = (expr) => SKILL_RUNTIMES.map((r) => `    ${r.id}) printf '%s' "${expr(r)}" ;;`).join("\n");
  return {
    ids: SKILL_RUNTIMES.map((r) => r.id).join(" "),
    functions:
      `home_for() {\n  case "$1" in\n${cases(homeOf)}\n  esac\n}\n` +
      `dir_for() {\n  case "$1" in\n${cases(dirOf)}\n  esac\n}`,
  };
}

/**
 * The shell for `--engine`: which agents take a registration and what each one needs.
 * Rendered from ENGINE_TARGETS so adding an agent is one line there.
 */
export function engineShell() {
  const mcp = ENGINE_TARGETS.filter((t) => t.mode === "mcp");
  const bridge = ENGINE_TARGETS.filter((t) => t.mode === "bridge");
  const none = ENGINE_TARGETS.filter((t) => t.mode === "none");
  return {
    ids: ENGINE_TARGETS.map((t) => t.id).join(" "),
    mcpIds: mcp.map((t) => t.id).join(" "),
    bridgeIds: bridge.map((t) => t.id).join(" "),
    noneIds: none.map((t) => t.id).join(" "),
    pathCases: mcp.map((t) => `    ${t.id}) printf '%s' "$HOME/${t.path}" ;;`).join("\n"),
    keyCases: mcp.map((t) => `    ${t.id}) printf '%s' "${t.key}" ;;`).join("\n"),
    formatCases: mcp.map((t) => `    ${t.id}) printf '%s' "${t.format || "json"}" ;;`).join("\n"),
  };
}

// Same shape as a skill's slug (skillsRepo.js, skillBundlesRepo.js): lower-case,
// digits, single dashes — it becomes a shell `case` label and an unpack directory.
const SAFE_BUNDLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A double-quoted shell string: escape what could otherwise break out of it.
const escDq = (value) => String(value ?? "").replace(/(["$`\\])/g, "\\$1");

/**
 * The shell for the bundle engine blocks: one `case` arm per published bundle for
 * its tarball URL, its omp-bridge fallback URL, and its installer entrypoint path
 * — the data-driven replacement for the former single hardcoded engine source
 * (design.md). A bundle with an unsafe slug or entrypoint is left out rather than
 * thrown on: skillBundlesRepo's own validation already refuses those at write
 * time, so this is only a second line of defence for a script every customer runs.
 */
export function bundleShell(bundles = []) {
  const safe = bundles.filter(
    (b) => SAFE_BUNDLE_SLUG.test(b?.slug ?? "") && (!b.installerEntrypoint || SAFE_PATH.test(b.installerEntrypoint)),
  );
  return {
    slugs: safe.map((b) => b.slug).join(" "),
    tarballCases: safe.map((b) => `    ${b.slug}) printf '%s' "${escDq(bundleTarballUrl(b))}" ;;`).join("\n"),
    bridgeCases: safe
      .map((b) => `    ${b.slug}) printf '%s' "${escDq(bundleRawFileUrl(b, "omp/rt-engine.ts"))}" ;;`)
      .join("\n"),
    installerCases: safe.map((b) => `    ${b.slug}) printf '%s' "${escDq(b.installerEntrypoint || "")}" ;;`).join("\n"),
  };
}

/**
 * The install script with this server's public origin filled in ("" origin leaves
 * --url required), and one engine block per published bundle.
 *
 * @param {string} origin
 * @param {object[]} [bundles] published bundles (skillBundlesRepo.listPublishedBundles()),
 *   each carrying slug, sourceHost/Owner/Repo/Ref and installerEntrypoint
 */
export function buildInstallScript(origin, bundles = []) {
  const safe = isSafeOrigin(origin) ? origin : "";
  const shell = runtimeShell();
  const engine = engineShell();
  const bundle = bundleShell(bundles);
  // `${` cannot appear inside the template literal, so the script spells shell
  // parameter expansion as `@{` and it is restored here.
  return TEMPLATE
    .replaceAll("__ORIGIN__", safe)
    .replaceAll("__RUNTIME_IDS__", shell.ids)
    .replaceAll("__SHARED_DIR__", SHARED_SKILLS_DIR)
    .replaceAll("__RUNTIME_FUNCS__", shell.functions)
    .replaceAll("__ENGINE_IDS__", engine.ids)
    .replaceAll("__ENGINE_MCP_IDS__", engine.mcpIds)
    .replaceAll("__ENGINE_BRIDGE_IDS__", engine.bridgeIds)
    .replaceAll("__ENGINE_NONE_IDS__", engine.noneIds)
    .replaceAll("__ENGINE_PATH_CASES__", engine.pathCases)
    .replaceAll("__ENGINE_KEY_CASES__", engine.keyCases)
    .replaceAll("__ENGINE_FORMAT_CASES__", engine.formatCases)
    .replaceAll("__ENGINE_HOME_BASE__", ENGINE_HOME_BASE)
    .replaceAll("__BUNDLE_SLUGS__", bundle.slugs)
    .replaceAll("__BUNDLE_TARBALL_CASES__", bundle.tarballCases)
    .replaceAll("__BUNDLE_BRIDGE_CASES__", bundle.bridgeCases)
    .replaceAll("__BUNDLE_INSTALLER_CASES__", bundle.installerCases)
    .replaceAll("__NODE_MIN__", NODE_MIN.major + "." + NODE_MIN.minor)
    .replaceAll("@{", "$" + "{");
}
