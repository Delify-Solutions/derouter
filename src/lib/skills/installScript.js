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

// Only a plain http(s) origin is ever written into the script, because the
// value is placed inside single quotes.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

export function isSafeOrigin(origin) {
  return typeof origin === "string" && ORIGIN_RE.test(origin);
}

const TEMPLATE = String.raw`#!/bin/sh
# derouter skill installer. Installs the skills your account may use into the agents
# on this machine (Claude Code, Codex, Cursor).
#
#   curl -fsSL __ORIGIN__/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- --all
#
# Options:
#   --all             install every skill in the catalogue
#   --list            only list the catalogue
#   --target <names>  claude, codex, cursor (comma list or repeated); default: every
#                     agent the skill supports that is installed on this machine
#   --dir <path>      install under <path>/<slug>/ instead of an agent's directory
#   --url <origin>    server address (default: the one this script came from)
#   <slug> ...        install only these skills
#
# The key is read from DEROUTER_KEY, or asked for without echo. It is never
# written to disk and never put on a command line.
set -eu
# No pathname expansion: every unquoted expansion below is a plain word list.
set -f

BASE="@{DEROUTER_URL:-__ORIGIN__}"
KEY="@{DEROUTER_KEY:-}"
RUNTIMES="claude codex cursor"

die() { printf 'Lỗi: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Dùng: curl -fsSL <địa-chỉ>/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- [tuỳ chọn] [slug ...]

  --all              cài mọi skill trong danh sách
  --list             chỉ liệt kê, không cài
  --target <tên>     claude, codex, cursor (nhiều tên cách nhau dấu phẩy)
                     mặc định: mọi agent skill hỗ trợ mà máy này đang có
  --dir <đường dẫn>  cài vào <đường dẫn>/<slug>/
  --url <địa chỉ>    địa chỉ máy chủ
USAGE
}

home_for() { printf '%s/.%s' "$HOME" "$1"; }
dir_for() { printf '%s/.%s/skills' "$HOME" "$1"; }

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

main() {
  command -v curl >/dev/null 2>&1 || die "cần có curl"

  ALL=0; LIST=0; TARGETS=""; DIR=""; SLUGS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) ALL=1 ;;
      --list) LIST=1 ;;
      --target) [ $# -ge 2 ] || die "--target cần một giá trị"; TARGETS="$TARGETS,$2"; shift ;;
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
      case " $RUNTIMES " in *" $name "*) ;; *) die "--target chỉ nhận claude, codex hoặc cursor (nhận: $name)" ;; esac
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

  code="$(fetch "$BASE/api/public/skills/catalog" "$WORK/catalog")" || die "không kết nối được $BASE"
  [ "$code" = "200" ] || explain "$code"
  [ -s "$WORK/catalog" ] || die "chưa có skill nào được phát hành cho tài khoản này"

  if [ "$LIST" = "1" ] || { [ "$ALL" = "0" ] && [ -z "$SLUGS" ]; }; then
    printf '%-32s %-22s %-8s %s\n' SLUG AGENT VERSION TÊN
    while IFS="$(printf '\t')" read -r slug file version target name; do
      [ -n "$slug" ] || continue
      printf '%-32s %-22s %-8s %s\n' "$slug" "$target" "$version" "$name"
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
    # Every agent must be one this script knows: the name becomes "$HOME/.<name>/skills".
    for name in $(printf '%s' "$target" | tr ',' ' '); do
      case " $RUNTIMES " in *" $name "*) ;; *) die "agent không hợp lệ từ máy chủ: $name" ;; esac
    done
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
    before="$installed"
    for rt in $RUNTIMES; do
      case ",$target," in *",$rt,"*) ;; *) continue ;; esac
      if [ -n "$TARGETS" ]; then
        case ",$TARGETS" in *",$rt,"*) ;; *) continue ;; esac
      elif [ ! -d "$(home_for "$rt")" ]; then
        continue
      fi
      install_one "$slug" "$file" "$rt" "$(dir_for "$rt")"
    done

    if [ "$installed" = "$before" ]; then
      if [ -n "$TARGETS" ]; then
        printf '%s: bỏ qua (skill dành cho %s, không có trong --target)\n' "$slug" "$target"
      else
        # No supported agent found here: put it where the skill's first agent will look.
        first="$(printf '%s' "$target" | cut -d, -f1)"
        printf '%s: chưa thấy agent nào trên máy, cài cho %s\n' "$slug" "$first"
        install_one "$slug" "$file" "$first" "$(dir_for "$first")"
      fi
    fi
  done <"$WORK/catalog"

  printf '\nXong: %s bản cài. Mở lại phiên Claude Code / Codex / Cursor để nạp skill mới.\n' "$installed"
}

main "$@"
`;

/** The install script with this server's public origin filled in; "" origin leaves --url required. */
export function buildInstallScript(origin) {
  const safe = isSafeOrigin(origin) ? origin : "";
  // `${` cannot appear inside the template literal, so the script spells shell
  // parameter expansion as `@{` and it is restored here.
  return TEMPLATE.replaceAll("__ORIGIN__", safe).replaceAll("@{", "$" + "{");
}
