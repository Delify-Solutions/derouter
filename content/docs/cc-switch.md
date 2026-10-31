---
slug: cc-switch
title: CC Switch
section: Kết nối công cụ
excerpt: Ứng dụng desktop quản lý provider cho Claude Code, Codex, OpenCode và các công cụ khác.
summary: Cài CC Switch, thêm router làm provider và đổi qua lại giữa các công cụ mà không sửa tệp cấu hình bằng tay.
sortOrder: 100
---

CC Switch là ứng dụng desktop miễn phí giúp quản lý cấu hình provider cho các công cụ lập trình AI. Thay vì sửa `settings.json`, `config.toml` hay `opencode.json` bằng tay, bạn nhập base URL và API key một lần, rồi chuyển provider bằng một cú nhấp. Đây là dự án độc lập, không phải sản phẩm của trang này. Mã nguồn: github.com/farion1231/cc-switch.

> **Đã kiểm tra** với CC Switch v4.0.22 và bộ tài liệu hướng dẫn trong repo chính thức (user-manual), ngày 31/10/2026. Tên nút và ô nhập dưới đây theo tài liệu của họ, chưa được đối chiếu với giao diện thật. Nếu giao diện bản bạn dùng khác, hãy làm theo ý nghĩa.

Mỗi trang công cụ trong tài liệu này đều có tab **CC Switch** và tab **Thủ công**. Bạn chọn cách nào cũng được, và lựa chọn được nhớ cho các trang sau.

## Công cụ được hỗ trợ

README của CC Switch liệt kê các công cụ sau. Trang này chỉ có hướng dẫn cho năm công cụ đầu:

| Công cụ | Trang hướng dẫn |
| --- | --- |
| Claude Code | [Claude Code](/docs/claude-code) |
| Claude Desktop | [Claude Desktop](/docs/claude-desktop) |
| Codex | [OpenAI Codex CLI](/docs/codex) |
| OpenCode | [OpenCode](/docs/opencode) |
| Oh My Pi (OMP) | [OMP](/docs/omp) |
| Gemini CLI, Grok Build, OpenClaw, Hermes, Pi, MiniMax Code, Kimi Code | Chưa có hướng dẫn riêng |

![Thanh bên trái của CC Switch với danh sách công cụ được hỗ trợ](/docs-img/cc-switch/03-tools-list.png)

## Cài đặt

CC Switch chạy trên Windows 10 trở lên, macOS 12 trở lên và Linux (x86_64 hoặc ARM64, cần glibc 2.35 trở lên và WebKitGTK 4.1, tức Ubuntu 22.04 hoặc Debian 12 trở lên).

| Hệ điều hành | Cách cài |
| --- | --- |
| macOS | `brew install --cask cc-switch`, hoặc tải `.dmg` từ trang Releases |
| Windows | Tải `.msi` (hoặc bản portable `.zip`) từ trang Releases |
| Linux | Tải `.deb`, `.rpm` hoặc `.AppImage` từ trang Releases |
| Arch Linux | `paru -S cc-switch-bin` |

Trang Releases: github.com/farion1231/cc-switch/releases. Nâng cấp bản cài bằng Homebrew: `brew upgrade --cask cc-switch`.

![CC Switch vừa cài xong, màn hình chính khi chưa có provider nào](/docs-img/cc-switch/01-install.png)

## Thêm router làm provider

Các bước chung, áp dụng cho mọi công cụ:

1. Chọn công cụ ở thanh bên trái.
2. Nhấn nút **+** (Add Provider) ở góc trên bên phải.
3. Chọn **Custom Configuration** (luôn ở đầu danh mục **All**). Nếu tìm preset không ra, dùng nút **Add with a custom config**.
4. Điền endpoint, API key và model. Địa chỉ endpoint khác nhau tùy công cụ, xem bảng dưới.
5. Nhấn **Add**.
6. Kích hoạt: với Claude Code, Claude Desktop và Codex, nhấn **Switch** trên thẻ provider (thẻ hiện **In use**). Với OpenCode, nút là **Add**, còn với Oh My Pi là **Enable**.

![Hộp thoại Add Provider của CC Switch ở bước chọn Custom Configuration](/docs-img/cc-switch/02-add-provider.png)

Địa chỉ endpoint cho từng công cụ (thay `YOUR-DOMAIN` bằng địa chỉ của trang này; xem [Bắt đầu nhanh](/docs/quickstart) để biết lấy ở đâu):

| Công cụ | Endpoint |
| --- | --- |
| Claude Code, Claude Desktop | `https://YOUR-DOMAIN` |
| Codex, OpenCode, Oh My Pi | `https://YOUR-DOMAIN/v1` |

CC Switch mặc định coi endpoint là tiền tố và tự nối thêm đường dẫn như `/v1/chat/completions`. Nó cũng có chế độ Full URL (cần bật dịch vụ routing) dùng nguyên địa chỉ bạn nhập. Với router này bạn không cần chế độ đó.

## Những điều cần biết

- CC Switch ghi vào tệp cấu hình của từng công cụ (ví dụ `~/.claude/settings.json`, `~/.codex/config.toml`). Chỉ các khóa liên quan được ghi, quyền, hooks và plugin giữ nguyên.
- Biến môi trường như `ANTHROPIC_*` hay `OPENAI_*` có sẵn trong shell có thể đè lên cấu hình. CC Switch hiện banner "Environment Variable Conflicts Detected" khi phát hiện. Bạn có thể xóa chúng từ banner (CC Switch sao lưu trước vào `~/.cc-switch/backups/`), rồi mở lại terminal.
- Với Codex và OpenCode, đóng và mở lại terminal sau khi đổi provider. Claude Desktop cần thoát hẳn và mở lại. Claude Code theo tài liệu của CC Switch áp dụng ngay.
- CC Switch còn có dịch vụ routing cục bộ (mặc định `127.0.0.1:15721`) để chuyển đổi định dạng và failover. Router này đã nói được cả giao thức OpenAI và Claude, nên bạn không cần bật dịch vụ đó, trừ khi dùng Model mapping cho Claude Desktop.
- Tên các nút có thể hơi khác giữa các tài liệu của CC Switch (ví dụ **Switch** và **Enable**). Làm theo nút hiện trên màn hình của bạn.
