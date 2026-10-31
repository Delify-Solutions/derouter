---
slug: codex
title: OpenAI Codex CLI
section: Kết nối công cụ
excerpt: Khai báo router như một model provider trong config.toml của Codex.
summary: Cấu hình Codex CLI bằng CC Switch hoặc bằng ~/.codex/config.toml, với wire_api responses.
sortOrder: 130
---

Codex CLI gọi model qua giao thức OpenAI Responses. Router có endpoint `/v1/responses`, nên Codex chạy được mà không cần chuyển đổi gì thêm.

> **Đã kiểm tra** với Codex CLI 0.166.0 và tài liệu cấu hình chính thức (config reference, config advanced) tại learn.chatgpt.com/docs, ngày 31/10/2026. Mã nguồn Codex hiện chỉ chấp nhận `wire_api = "responses"`. Giá trị `"chat"` đã bị gỡ, và gateway chỉ có Chat Completions sẽ không dùng được với bản mới.

Bạn cần API key (xem [Bắt đầu nhanh](/docs/quickstart)) và tên một model trong `/v1/models`. `MODEL-ID` bên dưới là tên đó.

:::tabs
::tab[CC Switch]
CC Switch viết hộ phần provider vào cấu hình Codex. Cài CC Switch theo [hướng dẫn](/docs/cc-switch) trước.

1. Trong thanh bên trái, chọn **Codex**.
2. Nhấn **+** (Add Provider) ở góc trên bên phải, rồi chọn **Custom Configuration**.
3. Điền endpoint là `https://YOUR-DOMAIN/v1`, API key là key `sk-...` của bạn và model là `MODEL-ID`. Phần cấu hình `config.toml` trong trình soạn thảo có dạng:

```toml
model_provider = "custom"
model = "MODEL-ID"

[model_providers.custom]
name = "custom"
base_url = "https://YOUR-DOMAIN/v1"
wire_api = "responses"
requires_openai_auth = true
```

Phần xác thực trong trình soạn thảo là `{"OPENAI_API_KEY": "sk-YOUR-KEY"}`.

![Form thêm provider tùy chỉnh cho Codex trong CC Switch, đã điền endpoint, API key và model](/docs-img/codex/ccswitch-01-provider-form.png)

4. Nhấn **Add**, rồi nhấn **Switch** trên thẻ provider. Khi chuyển sang provider bên thứ ba, CC Switch ghi key vào `[model_providers.custom]` trong `~/.codex/config.toml` và bỏ đăng nhập ChatGPT khỏi `auth.json` (nó lưu bản sao để khôi phục khi chuyển về).
5. Đóng terminal đang chạy Codex và mở lại. Codex không nạp lại cấu hình khi đang chạy.

![Codex đang chạy sau khi chuyển provider trong CC Switch, trả lời một yêu cầu](/docs-img/codex/ccswitch-02-running.png)

Nếu CC Switch hiện cảnh báo biến môi trường xung đột với `OPENAI_*`, xóa các biến đó theo hướng dẫn trong banner rồi mở lại terminal.

::tab[Thủ công]
Sửa `~/.codex/config.toml`. Thư mục `~/.codex` đổi được bằng biến `CODEX_HOME`. Trên Windows, tài liệu chính thức không ghi đường dẫn cụ thể. Thông thường là `%USERPROFILE%\.codex\config.toml`, nhưng điều này chưa được xác nhận từ nguồn chính thức.

```toml
model_provider = "derouter"
model = "MODEL-ID"

[model_providers.derouter]
name = "derouter"
base_url = "https://YOUR-DOMAIN/v1"
env_key = "DEROUTER_API_KEY"
wire_api = "responses"
```

![Tệp ~/.codex/config.toml mở trong trình soạn thảo với khối model_providers.derouter](/docs-img/codex/manual-01-config.png)

Đặt key vào biến môi trường mà `env_key` chỉ tới. Tên biến do bạn chọn, ở đây là `DEROUTER_API_KEY`.

```bash
export DEROUTER_API_KEY=sk-YOUR-KEY
```

Trên Windows PowerShell: `$env:DEROUTER_API_KEY = "sk-YOUR-KEY"`.

Giải thích các khóa:

| Khóa | Ý nghĩa |
| --- | --- |
| `model_provider` | id của provider trong `model_providers` mà Codex dùng |
| `model` | Tên model, lấy từ `/v1/models` |
| `base_url` | Địa chỉ gốc của API. Dùng dạng có `/v1` vì Codex gọi `/v1/responses` |
| `env_key` | Tên biến môi trường chứa API key |
| `wire_api` | Chỉ nhận `responses` (cũng là mặc định) |

Chạy `codex` trong thư mục dự án. Lần đầu, nếu Codex hỏi đăng nhập, kiểm tra lại `env_key` và rằng biến đã được export trong cùng terminal.

![Codex đang chạy với provider derouter, trả lời một yêu cầu](/docs-img/codex/manual-02-running.png)

Lưu ý:

- Không đặt `requires_openai_auth = true` khi dùng `env_key`: khi đó Codex bỏ qua `env_key` và dùng đăng nhập OpenAI.
- Các id `openai`, `ollama` và `lmstudio` là id có sẵn và không ghi đè được. Đừng dùng chúng làm id provider.
- Codex bỏ qua `model_provider` và `model_providers` trong `.codex/config.toml` của dự án. Hãy đặt chúng trong tệp cấp người dùng.
- Từ Codex 0.134, mục `[profiles.x]` trong `config.toml` không còn dùng được. Hồ sơ nay là tệp riêng `~/.codex/<tên>.config.toml` với các khóa ở cấp cao nhất, chọn bằng `codex --profile <tên>`.
:::

## Khi gặp lỗi

- Codex báo `wire_api = "chat" is no longer supported`: đổi thành `wire_api = "responses"`.
- Lỗi 404 ngay lần gọi đầu: kiểm tra `base_url` có kết thúc bằng `/v1` và tên model có trong `/v1/models`.
- Lỗi 401, 402, 403, 429 từ router: xem [Bắt đầu nhanh](/docs/quickstart).
