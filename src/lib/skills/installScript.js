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
# derouter skill installer. Installs the skills your account may use into the
# directory your agent (Claude Code, Codex, Cursor) reads them from.
#
#   curl -fsSL __ORIGIN__/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- --all
#
# Options:
#   --all             install every skill in the catalogue
#   --list            only list the catalogue
#   --target <name>   claude | codex | cursor  (default: each skill's own runtime)
#   --dir <path>      install under <path>/<slug>/ instead of the runtime default
#   --url <origin>    server address (default: the one this script came from)
#   <slug> ...        install only these skills
#
# The key is read from DEROUTER_KEY, or asked for without echo. It is never
# written to disk and never put on a command line.
set -eu

BASE="@{DEROUTER_URL:-__ORIGIN__}"
KEY="@{DEROUTER_KEY:-}"

die() { printf 'Lỗi: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Dùng: curl -fsSL <địa-chỉ>/api/public/skills/install.sh | DEROUTER_KEY=<api key> sh -s -- [tuỳ chọn] [slug ...]

  --all             cài mọi skill trong danh sách
  --list            chỉ liệt kê, không cài
  --target <tên>    claude | codex | cursor (mặc định: theo từng skill)
  --dir <đường dẫn> cài vào <đường dẫn>/<slug>/
  --url <địa chỉ>   địa chỉ máy chủ
USAGE
}

dir_for() {
  # $1 = runtime. Anything unknown is treated as Claude Code.
  case "$1" in
    codex) printf '%s/.codex/skills' "$HOME" ;;
    cursor) printf '%s/.cursor/skills' "$HOME" ;;
    *) printf '%s/.claude/skills' "$HOME" ;;
  esac
}

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

main() {
  command -v curl >/dev/null 2>&1 || die "cần có curl"

  ALL=0; LIST=0; TARGET=""; DIR=""; SLUGS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) ALL=1 ;;
      --list) LIST=1 ;;
      --target) [ $# -ge 2 ] || die "--target cần một giá trị"; TARGET="$2"; shift ;;
      --dir) [ $# -ge 2 ] || die "--dir cần một giá trị"; DIR="$2"; shift ;;
      --url) [ $# -ge 2 ] || die "--url cần một giá trị"; BASE="$2"; shift ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; die "tuỳ chọn không hợp lệ: $1" ;;
      *) SLUGS="$SLUGS $1" ;;
    esac
    shift
  done

  [ -n "$BASE" ] || die "không biết địa chỉ máy chủ, thêm --url https://..."
  # The key travels in a header, so only HTTPS (or this machine) may receive it.
  case "$BASE" in
    https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|"http://[::1]"|"http://[::1]:"*) ;;
    *) die "địa chỉ máy chủ phải là https:// (không gửi key qua http)" ;;
  esac
  case "$TARGET" in ""|claude|codex|cursor) ;; *) die "--target chỉ nhận claude, codex hoặc cursor" ;; esac

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
    printf '%-32s %-10s %-8s %s\n' SLUG RUNTIME VERSION TÊN
    while IFS="$(printf '\t')" read -r slug file version target name; do
      [ -n "$slug" ] || continue
      printf '%-32s %-10s %-8s %s\n' "$slug" "$target" "$version" "$name"
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
    if [ -n "$DIR" ]; then root="$DIR"; else root="$(dir_for "@{TARGET:-$target}")"; fi
    dest="$root/$slug"
    mkdir -p "$dest" || die "không tạo được $dest"

    code="$(fetch "$BASE/api/public/skills/file/$slug" "$WORK/$slug.md")" || die "không kết nối được $BASE"
    [ "$code" = "200" ] || explain "$code"
    [ -s "$WORK/$slug.md" ] || die "skill $slug rỗng"

    if [ -f "$dest/$file" ] && cmp -s "$WORK/$slug.md" "$dest/$file"; then
      state="đã là bản mới nhất"
    elif [ -f "$dest/$file" ]; then
      state="đã cập nhật"
    else
      state="đã cài"
    fi
    cp "$WORK/$slug.md" "$dest/$file.tmp" && mv -f "$dest/$file.tmp" "$dest/$file" || die "không ghi được $dest/$file"
    printf '%s: %s -> %s/%s\n' "$slug" "$state" "$dest" "$file"
    installed=$((installed + 1))
  done <"$WORK/catalog"

  printf '\nXong: %s skill. Mở lại phiên Claude Code / Codex / Cursor để nạp skill mới.\n' "$installed"
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
