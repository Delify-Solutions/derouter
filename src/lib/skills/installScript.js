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
import { ENGINE_TARGETS, ENGINE_TARBALL, ENGINE_BRIDGE_URL, ENGINE_HOME, NODE_MIN } from "./engineTargets.js";

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
#   --all             install every skill in the catalogue
#   --list            only list the catalogue
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
ENGINE_TARBALL="__ENGINE_TARBALL__"
ENGINE_HOME="__ENGINE_HOME__"
NODE_MIN="__NODE_MIN__"
CANON="$HOME/__SHARED_DIR__"
COPY=0
# Where the choice is read from when no skill is named; the terminal, not stdin
# (stdin is this script when it is piped into sh).
TTY="@{DEROUTER_TTY:-/dev/tty}"

die() { printf 'Lỗi: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Dùng: curl -fsSL <địa-chỉ>/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- [tuỳ chọn] [slug ...]

  --all              cài mọi skill trong danh sách
  --list             chỉ liệt kê, không cài
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
# The skills call 67 tools that live in a Node MCP server. Without it a skill loads,
# reads a tool name, finds nothing, and stops. --engine fetches that server and
# registers it with each agent that can take one.
#
# omp has no MCP client, so it gets a bridge extension instead; dsh owns its own copy
# and is skipped. Both facts live in ENGINE_MCP / ENGINE_BRIDGE / ENGINE_NONE above.

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

# Write the MCP registration for one agent. Merges into an existing config rather
# than replacing it: the customer's own servers must survive.
register_mcp() {
  r_agent="$1"; r_key="$2"; r_config="$3"; r_node="$4"; r_server="$5"
  mkdir -p "$(dirname "$r_config")" 2>/dev/null || true
  if "$r_node" -e '
const fs = require("fs");
const [configPath, agent, keyName, nodePath, serverPath] = process.argv.slice(1);
let data = {};
try { data = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { data = {}; }
// amp nests its key ("amp.mcpServers"); everything else is top level.
const parts = keyName.split(".");
let holder = data;
for (const part of parts.slice(0, -1)) {
  if (!holder[part] || typeof holder[part] !== "object") holder[part] = {};
  holder = holder[part];
}
const leaf = parts[parts.length - 1];
if (!holder[leaf] || typeof holder[leaf] !== "object") holder[leaf] = {};
holder[leaf]["rt-claude"] = {
  command: nodePath,
  args: [serverPath],
  env: { DSH_HOME: process.env.DSH_HOME || (process.env.HOME + "/.dsh") },
};
fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
' "$r_config" "$r_agent" "$r_key" "$r_node" "$r_server" 2>/dev/null; then
    printf 'engine [%s]: đã đăng ký MCP -> %s\n' "$r_agent" "$r_config"
  else
    printf 'engine [%s]: KHÔNG ghi được %s\n' "$r_agent" "$r_config" >&2
    return 1
  fi
}

# Fetch and unpack the engine, once. Returns its mcp-server.mjs path in ENGINE_SERVER.
install_engine_source() {
  e_root="$HOME/$ENGINE_HOME"
  e_server="$e_root/lib/mcp-server.mjs"
  if [ -f "$e_server" ]; then
    # Update is how you refresh: the bundle is fetched fresh, so honour the flag
    # rather than asking the customer to guess a second switch.
    if [ "$UPDATE_ENGINE" = "1" ]; then
      printf 'engine: cập nhật %s\n' "$e_root"
    else
      printf 'engine: đã có ở %s (--engine-update để làm mới)\n' "$e_root"
      ENGINE_SERVER="$e_server"
      return 0
    fi
  fi
  e_tar="$WORK/engine.tar.gz"
  printf 'engine: tải %s\n' "$ENGINE_TARBALL"
  code="$(curl -sSL -o "$e_tar" -w '%{http_code}' "$ENGINE_TARBALL")" || die "không tải được engine"
  [ "$code" = "200" ] || die "không tải được engine (HTTP $code)"
  e_tmp="$WORK/engine-unpack"
  mkdir -p "$e_tmp" || die "không tạo được thư mục giải nén"
  # Strip the single top-level directory the tarball carries.
  tar -xzf "$e_tar" -C "$e_tmp" --strip-components=1 2>/dev/null \
    || die "không giải nén được engine (cần tar)"
  [ -f "$e_tmp/lib/mcp-server.mjs" ] || die "gói engine thiếu lib/mcp-server.mjs"
  mkdir -p "$e_root" || die "không tạo được $e_root"
  cp -R "$e_tmp/." "$e_root/" || die "không chép được engine vào $e_root"
  printf 'engine: đã cài vào %s\n' "$e_root"
  ENGINE_SERVER="$e_root/lib/mcp-server.mjs"
}

install_engine() {
  e_node="$(node_for_engine)" || die "cần Node >= $NODE_MIN cho engine (node:sqlite). Cài Node rồi thử lại, hoặc bỏ --engine."
  printf 'engine: node %s (%s)\n' "$("$e_node" -v 2>/dev/null)" "$e_node"
  install_engine_source
  [ -n "$ENGINE_SERVER" ] || die "không xác định được engine"

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

  for e_rt in $e_wanted; do
    case " $ENGINE_MCP " in
      *" $e_rt "*)
        register_mcp "$e_rt" "$(engine_key_for "$e_rt")" "$(engine_path_for "$e_rt")" "$e_node" "$ENGINE_SERVER" || true
        ;;
    esac
    case " $ENGINE_BRIDGE " in
      *" $e_rt "*)
        e_bridge="$(home_for "$e_rt")/agent/extensions/rt-engine.ts"
        mkdir -p "$(dirname "$e_bridge")" 2>/dev/null || true
        e_src="$HOME/$ENGINE_HOME/omp/rt-engine.ts"
        # The bundle normally carries the bridge. A tarball built before it existed
        # (a GitHub codeload cache, say) does not, so fall back to fetching the one
        # file rather than leaving omp with skills and no tools.
        if [ ! -f "$e_src" ]; then
          e_url="__ENGINE_BRIDGE_URL__"
          if [ -n "$e_url" ]; then
            curl -sSL -o "$WORK/bridge.ts" "$e_url" 2>/dev/null && e_src="$WORK/bridge.ts"
          fi
        fi
        if [ -f "$e_src" ]; then
          cp "$e_src" "$e_bridge" && printf 'engine [%s]: đã cài bridge -> %s\n' "$e_rt" "$e_bridge"
        else
          printf 'engine [%s]: không lấy được bridge (bỏ qua)\n' "$e_rt" >&2
        fi
        ;;
    esac
  done

  for e_rt in $ENGINE_NONE; do
    case " $e_wanted " in
      *" $e_rt "*) printf 'engine [%s]: agent này tự quản engine riêng, bỏ qua\n' "$e_rt" ;;
    esac
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

  ALL=0; LIST=0; TARGETS=""; DIR=""; SLUGS=""; WITH_ENGINE=0; ENGINE_ONLY=0; UPDATE_ENGINE=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) ALL=1 ;;
      --list) LIST=1 ;;
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

  # Nothing named and a terminal to ask: show the catalogue numbered and let the
  # customer pick some, or all.
  if [ "$LIST" = "0" ] && [ "$ALL" = "0" ] && [ -z "$SLUGS" ] && ( : <"$TTY" ) 2>/dev/null; then
    count=0
    printf '%s\n' "Skill bạn có thể cài:" >&2
    while IFS="$(printf '\t')" read -r slug file version target name; do
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
        a|A|all|ALL) ALL=1 ;;
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
    while IFS="$(printf '\t')" read -r slug file version target name; do
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
  while IFS="$(printf '\t')" read -r slug file version target name; do
    [ -n "$slug" ] || continue
    case "$slug" in ""|*[!a-z0-9-]*|-*|*-) die "slug không hợp lệ từ máy chủ: $slug" ;; esac
    case "$file" in ""|*[!A-Za-z0-9._-]*|.*) die "tên file không hợp lệ từ máy chủ: $file" ;; esac
    case "$target" in ""|*[!a-z,]*|,*|*,|*,,*) die "danh sách agent không hợp lệ từ máy chủ: $target" ;; esac
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
  while IFS="$(printf '\t')" read -r slug file version target name; do
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
  };
}

/** The install script with this server's public origin filled in; "" origin leaves --url required. */
export function buildInstallScript(origin) {
  const safe = isSafeOrigin(origin) ? origin : "";
  const shell = runtimeShell();
  const engine = engineShell();
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
    .replaceAll("__ENGINE_TARBALL__", ENGINE_TARBALL)
    .replaceAll("__ENGINE_BRIDGE_URL__", ENGINE_BRIDGE_URL)
    .replaceAll("__ENGINE_HOME__", ENGINE_HOME)
    .replaceAll("__NODE_MIN__", NODE_MIN.major + "." + NODE_MIN.minor)
    .replaceAll("@{", "$" + "{");
}
