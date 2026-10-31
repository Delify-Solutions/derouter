---
slug: claude-code
title: Claude Code
section: Kết nối công cụ
excerpt: Trỏ Claude Code vào base URL và API key của bạn, chọn model, xử lý ngữ cảnh dài.
summary: Cấu hình Claude Code (CLI) bằng CC Switch hoặc bằng biến môi trường và settings.json.
sortOrder: 110
---

Claude Code dùng giao thức Anthropic Messages. Router nhận giao thức này tại `/v1/messages`, nên bạn chỉ cần đổi địa chỉ và key.

> **Đã kiểm tra** với Claude Code 2.1.314 và tài liệu chính thức tại code.claude.com (LLM gateway, model configuration, environment variables), ngày 31/10/2026.

Trước khi bắt đầu, bạn cần một API key (xem [Bắt đầu nhanh](/docs/quickstart)) và tên các model của tài khoản trong `/v1/models`. Trong trang này `MODEL-ID` là tên model bạn chọn từ danh sách đó.

:::tabs
::tab[CC Switch]
CC Switch ghi cấu hình vào `~/.claude/settings.json` giúp bạn, và cho phép đổi qua lại giữa nhiều nhà cung cấp bằng một cú nhấp. Cài CC Switch theo [hướng dẫn](/docs/cc-switch) trước.

1. Trong thanh bên trái của CC Switch, chọn **Claude** (Claude Code, không phải Claude Desktop).
2. Nhấn nút **+** (Add Provider) ở góc trên bên phải.
3. Chọn **Custom Configuration**. Nếu danh sách preset trống, dùng nút **Add with a custom config**.
4. Điền endpoint là `https://YOUR-DOMAIN` (không có `/v1`) và API key là key `sk-...` của bạn. Nếu trình soạn thảo hiện JSON, dùng đúng dạng này:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-DOMAIN",
    "ANTHROPIC_AUTH_TOKEN": "sk-YOUR-KEY",
    "ANTHROPIC_MODEL": "MODEL-ID"
  }
}
```

![Form thêm provider tùy chỉnh cho Claude Code trong CC Switch, đã điền endpoint, API key và model](/docs-img/claude-code/ccswitch-01-provider-form.png)

5. Giữ **Upstream Format** ở mặc định Anthropic Messages (Native).
6. Nhấn **Add**, rồi nhấn **Switch** trên thẻ provider vừa tạo. Thẻ chuyển sang trạng thái **In use**.

![Danh sách provider của Claude Code trong CC Switch, thẻ provider mới đang ở trạng thái In use](/docs-img/claude-code/ccswitch-02-active.png)

7. Mở terminal và chạy `claude`. CC Switch áp dụng cấu hình ngay, không cần khởi động lại máy.

![Claude Code đang chạy, trả lời một câu hỏi bằng model từ router](/docs-img/claude-code/ccswitch-03-running.png)

Nếu Claude Code vẫn hiện màn hình đăng nhập, bật tùy chọn **Skip Claude Code first-run confirmation** trong Settings của CC Switch rồi mở lại Claude Code.

Nếu CC Switch hiện cảnh báo "Environment Variable Conflicts Detected", bạn đang có biến `ANTHROPIC_*` trong shell đè lên cấu hình. Xóa các biến đó theo hướng dẫn trong banner, rồi mở lại terminal.

::tab[Thủ công]
Có hai cách: biến môi trường trong shell, hoặc khối `env` trong `~/.claude/settings.json`. Chọn một. Nếu đặt cả hai, giá trị trong `settings.json` thường được dùng.

### Cách 1: biến môi trường

macOS và Linux (thêm vào `~/.zshrc` hoặc `~/.bashrc` để dùng lâu dài):

```bash
export ANTHROPIC_BASE_URL=https://YOUR-DOMAIN
export ANTHROPIC_AUTH_TOKEN=sk-YOUR-KEY
export ANTHROPIC_MODEL=MODEL-ID
```

Windows PowerShell (chỉ cho phiên hiện tại; dùng `setx` nếu muốn lưu lại):

```powershell
$env:ANTHROPIC_BASE_URL = "https://YOUR-DOMAIN"
$env:ANTHROPIC_AUTH_TOKEN = "sk-YOUR-KEY"
$env:ANTHROPIC_MODEL = "MODEL-ID"
```

### Cách 2: settings.json

Sửa `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://YOUR-DOMAIN",
    "ANTHROPIC_AUTH_TOKEN": "sk-YOUR-KEY",
    "ANTHROPIC_MODEL": "MODEL-ID"
  }
}
```

![Tệp ~/.claude/settings.json mở trong trình soạn thảo với khối env đã điền](/docs-img/claude-code/manual-01-settings.png)

Đặt key vào file ở thư mục home của bạn. Đừng đặt vào `.claude/settings.json` trong dự án, vì file đó thường được commit và chia sẻ.

### Chạy thử

Mở terminal mới và chạy `claude`. Trong Claude Code, gõ `/status` để xem địa chỉ và nguồn key đang dùng: dòng `Anthropic base URL` phải là địa chỉ của bạn.

![Claude Code đang chạy, lệnh /status hiện Anthropic base URL trỏ tới địa chỉ của router](/docs-img/claude-code/manual-02-running.png)
:::

## Chọn model

Claude Code gọi model theo tên bạn đặt. Tên phải khớp một mục trong `/v1/models`.

| Việc | Cách làm |
| --- | --- |
| Model mặc định cho phiên | `ANTHROPIC_MODEL=MODEL-ID` |
| Đổi model khi đang chạy | Gõ `/model MODEL-ID` trong Claude Code |
| Chọn model khi khởi động | `claude --model MODEL-ID` |

Claude Code còn dùng một model nhẹ cho tác vụ nền (như đặt tên phiên). Mặc định nó gọi tên model Claude của Anthropic, mà tài khoản của bạn có thể không có. Hãy chỉ định tên model thay thế để tránh lỗi:

```bash
export ANTHROPIC_DEFAULT_HAIKU_MODEL=MODEL-ID
export CLAUDE_CODE_SUBAGENT_MODEL=MODEL-ID
```

Tương tự, `ANTHROPIC_DEFAULT_SONNET_MODEL` và `ANTHROPIC_DEFAULT_OPUS_MODEL` quyết định model nào ứng với các bí danh `sonnet` và `opus`. Biến cũ `ANTHROPIC_SMALL_FAST_MODEL` đã bị Claude Code đánh dấu lỗi thời, hãy dùng `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

## Ngữ cảnh dài

Claude Code tự đoán kích thước ngữ cảnh theo tên model. Với tên nó không nhận ra, nó giả định ngữ cảnh 200K token và tự nén hội thoại theo mức đó. Nếu model của bạn có ngữ cảnh khác:

- Model có ngữ cảnh 1 triệu token: thêm hậu tố `[1m]` vào tên, ví dụ `claude --model 'MODEL-ID[1m]'`. Claude Code bỏ hậu tố `[1m]` trước khi gửi tên model đi, và router cũng bỏ nó nếu nhận được, nên tên model thật không bị đổi.
- Ngữ cảnh khác 1 triệu: đặt `CLAUDE_CODE_MAX_CONTEXT_TOKENS` bằng số token của model, ví dụ `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000`.
- Chỉ thêm `[1m]` khi model thật sự hỗ trợ 1 triệu token. Nếu không, request dài quá giới hạn của model sẽ bị từ chối (xem lỗi `context_length` ở [Xử lý sự cố](/docs/troubleshooting)).

## Lưu ý

- Claude Code được xây cho model Claude. Anthropic không hỗ trợ chính thức việc chạy nó với model không phải Claude qua gateway. Với model khác, một số tính năng (thinking, effort) có thể không hoạt động như bản gốc.
- Biến `ANTHROPIC_AUTH_TOKEN` gửi key trong header `Authorization: Bearer`. Nếu bạn dùng `ANTHROPIC_API_KEY`, key đi trong header `x-api-key`. Router nhận cả hai.
- Nếu Claude Code vẫn bắt đăng nhập dù key đúng, đặt `ANTHROPIC_AUTH_TOKEN` ở shell hoặc `~/.claude/settings.json`, không đặt ở `settings.json` của dự án.
- Lỗi 401, 402, 429: xem [Bắt đầu nhanh](/docs/quickstart). Các lỗi khác: xem [Xử lý sự cố](/docs/troubleshooting).
