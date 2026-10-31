# Danh sách ảnh chụp màn hình cho trang /docs

Mỗi ảnh được tham chiếu trong `content/docs/<slug>.md` và đặt tại `public/docs-img/<slug>/<tên>.png`. Khi thiếu ảnh, trang vẫn hiển thị khung viền kèm chú thích (alt text), nên có thể bổ sung dần.

## Quy tắc chung

- Định dạng PNG, rộng khoảng 1200 px, giao diện sáng. Cắt gọn, không để thừa thanh tiêu đề hay màn hình nền.
- Dùng tên miền và key giả trong ảnh: `YOUR-DOMAIN` hoặc một domain thử nghiệm, key dạng `sk-...` đã che bớt. Không để lộ key thật, email thật hay số tài khoản thật.
- Ảnh chụp terminal dùng font đơn cách cỡ vừa đọc được, nền tối hoặc sáng nhất quán trong cùng một trang.
- `MODEL-ID` trong tài liệu là tên model của tài khoản. Trong ảnh dùng một tên model có thật trong `/v1/models`.
- Chú thích hiển thị trong trang chính là cột "Màn hình cần chụp" bên dưới. Nếu đổi nội dung ảnh, sửa luôn alt text trong tệp Markdown.

Tổng cộng 35 ảnh.

| # | Tệp | Trang | Màn hình cần chụp | Ứng dụng và phiên bản |
| --- | --- | --- | --- | --- |
| 1 | `public/docs-img/quickstart/01-register.png` | quickstart | Trang Đăng ký với ô email và mật khẩu đã điền, nút Tạo tài khoản | Trình duyệt, trang web này (giao diện khách) |
| 2 | `public/docs-img/quickstart/02-plans.png` | quickstart | Trang Gói của tôi với danh sách gói có thể mua và nút Chọn gói | Trình duyệt, trang web này (giao diện khách) |
| 3 | `public/docs-img/quickstart/03-create-key.png` | quickstart | Hộp thoại sau khi tạo key, hiện secret bắt đầu bằng sk- cùng nút sao chép | Trình duyệt, trang web này (giao diện khách) |
| 4 | `public/docs-img/quickstart/04-base-url.png` | quickstart | Trang Tổng quan, mục Bắt đầu, hiện base URL và nút sao chép | Trình duyệt, trang web này (giao diện khách) |
| 5 | `public/docs-img/quickstart/06-curl-response.png` | quickstart | Terminal sau khi chạy lệnh curl chat/completions, hiện JSON phản hồi có trường choices | Terminal, curl |
| 6 | `public/docs-img/quickstart/05-usage-page.png` | quickstart | Trang /usage với API key đã dán, hiện tổng quan và bảng lịch sử request | Trình duyệt, trang web này (giao diện khách) |
| 7 | `public/docs-img/cc-switch/03-tools-list.png` | cc-switch | Thanh bên trái của CC Switch với danh sách công cụ được hỗ trợ | CC Switch v4.0.22 |
| 8 | `public/docs-img/cc-switch/01-install.png` | cc-switch | CC Switch vừa cài xong, màn hình chính khi chưa có provider nào | CC Switch v4.0.22 |
| 9 | `public/docs-img/cc-switch/02-add-provider.png` | cc-switch | Hộp thoại Add Provider của CC Switch ở bước chọn Custom Configuration | CC Switch v4.0.22 |
| 10 | `public/docs-img/claude-code/ccswitch-01-provider-form.png` | claude-code | Form thêm provider tùy chỉnh cho Claude Code trong CC Switch, đã điền endpoint, API key và model | CC Switch v4.0.22 (tab Claude) |
| 11 | `public/docs-img/claude-code/ccswitch-02-active.png` | claude-code | Danh sách provider của Claude Code trong CC Switch, thẻ provider mới đang ở trạng thái In use | CC Switch v4.0.22 (tab Claude) |
| 12 | `public/docs-img/claude-code/ccswitch-03-running.png` | claude-code | Claude Code đang chạy, trả lời một câu hỏi bằng model từ router | Claude Code 2.1.314 (sau khi chuyển bằng CC Switch) |
| 13 | `public/docs-img/claude-code/manual-01-settings.png` | claude-code | Tệp ~/.claude/settings.json mở trong trình soạn thảo với khối env đã điền | Claude Code 2.1.314 |
| 14 | `public/docs-img/claude-code/manual-02-running.png` | claude-code | Claude Code đang chạy, lệnh /status hiện Anthropic base URL trỏ tới địa chỉ của router | Claude Code 2.1.314 |
| 15 | `public/docs-img/claude-desktop/ccswitch-01-add-provider.png` | claude-desktop | Cửa sổ Add Provider của CC Switch, tab Claude Desktop, đã điền tên, endpoint URL và API key | CC Switch v4.0.22 (tab Claude Desktop) |
| 16 | `public/docs-img/claude-desktop/ccswitch-02-model-mapping.png` | claude-desktop | Bảng Model Mapping của provider, vai trò Sonnet có Menu display name và Requested model đã điền | CC Switch v4.0.22 (tab Claude Desktop) |
| 17 | `public/docs-img/claude-desktop/ccswitch-03-chat-working.png` | claude-desktop | Claude Desktop sau khi mở lại, menu chọn model hiện tên đã đặt và một hội thoại trả lời thành công | Claude Desktop (bản mới nhất) |
| 18 | `public/docs-img/claude-desktop/manual-01-settings.png` | claude-desktop | Cửa sổ Configure Third-Party Inference với Inference provider là Gateway, base URL và API key đã điền | Claude Desktop (bản mới nhất) |
| 19 | `public/docs-img/claude-desktop/manual-02-chat-working.png` | claude-desktop | Claude Desktop ở chế độ 3P, một hội thoại gửi tin nhắn và nhận trả lời | Claude Desktop (bản mới nhất) |
| 20 | `public/docs-img/codex/ccswitch-01-provider-form.png` | codex | Form thêm provider tùy chỉnh cho Codex trong CC Switch, đã điền endpoint, API key và model | CC Switch v4.0.22 (tab Codex) |
| 21 | `public/docs-img/codex/ccswitch-02-running.png` | codex | Codex đang chạy sau khi chuyển provider trong CC Switch, trả lời một yêu cầu | Codex CLI 0.166.0 (sau khi chuyển bằng CC Switch) |
| 22 | `public/docs-img/codex/manual-01-config.png` | codex | Tệp ~/.codex/config.toml mở trong trình soạn thảo với khối model_providers.derouter | Codex CLI 0.166.0 |
| 23 | `public/docs-img/codex/manual-02-running.png` | codex | Codex đang chạy với provider derouter, trả lời một yêu cầu | Codex CLI 0.166.0 |
| 24 | `public/docs-img/opencode/ccswitch-01-provider-form.png` | opencode | Form thêm provider OpenAI Compatible cho OpenCode trong CC Switch, đã điền endpoint, API key và một model | CC Switch v4.0.22 (tab OpenCode) |
| 25 | `public/docs-img/opencode/ccswitch-02-running.png` | opencode | OpenCode đang chạy, danh sách /models có model của provider vừa thêm và một phản hồi thành công | OpenCode 1.19.5 (sau khi chuyển bằng CC Switch) |
| 26 | `public/docs-img/opencode/manual-01-config.png` | opencode | Tệp ~/.config/opencode/opencode.json mở trong trình soạn thảo với provider derouter | OpenCode 1.19.5 |
| 27 | `public/docs-img/opencode/manual-02-running.png` | opencode | OpenCode đang chạy với model derouter/MODEL-ID đã chọn, trả lời một yêu cầu | OpenCode 1.19.5 |
| 28 | `public/docs-img/omp/ccswitch-01-provider-form.png` | omp | Form thêm provider tùy chỉnh cho Oh My Pi trong CC Switch, đã điền endpoint, API key và model | CC Switch v4.0.22 (tab Oh My Pi) |
| 29 | `public/docs-img/omp/ccswitch-02-running.png` | omp | OMP đang chạy, menu /model có model từ provider vừa thêm và một phản hồi thành công | OMP 18.14.0 (sau khi chuyển bằng CC Switch) |
| 30 | `public/docs-img/omp/manual-01-config.png` | omp | Tệp ~/.omp/agent/models.yml mở trong trình soạn thảo với provider derouter | OMP 18.14.0 |
| 31 | `public/docs-img/omp/manual-02-running.png` | omp | OMP đang chạy với model derouter/MODEL-ID, trả lời một yêu cầu | OMP 18.14.0 |
| 32 | `public/docs-img/sdk/01-python-sdk.png` | sdk | Terminal chạy script Python dùng OpenAI SDK, in ra câu trả lời của model | Terminal; Python 3 với gói openai 3.41.0 (ảnh 01), script streaming (ảnh 02) |
| 33 | `public/docs-img/sdk/02-streaming.png` | sdk | Terminal in câu trả lời từng phần khi chạy script streaming | Terminal; Python 3 với gói openai 3.41.0 (ảnh 01), script streaming (ảnh 02) |
| 34 | `public/docs-img/plans/01-queue.png` | plans | Trang Gói của tôi với hàng đợi gói, mỗi gói có credit còn lại, hạn dùng và nút đổi thứ tự | Trình duyệt, trang web này (giao diện khách) |
| 35 | `public/docs-img/plans/02-ledger.png` | plans | Trang Nhật ký credit với các dòng trừ credit, mỗi dòng ghi gói và số tiền | Trình duyệt, trang web này (giao diện khách) |
