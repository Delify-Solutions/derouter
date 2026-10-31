# Nhiệm vụ cho Claude Desktop (computer use): cài đặt, cấu hình và chụp ảnh tài liệu derouter

Bạn là trợ lý đang điều khiển máy tính của tôi (macOS) bằng computer use. Nhiệm vụ: kết nối từng công cụ AI bên dưới với dịch vụ **derouter** (bằng cách thủ công qua terminal/file cấu hình, và bằng CC Switch ở công cụ nào CC Switch hỗ trợ) (một proxy AI tương thích OpenAI và Anthropic), kiểm tra nó chạy thật, và **chụp ảnh màn hình đúng danh sách ở cuối file** để đưa vào tài liệu hướng dẫn.

Hãy đọc hết file này trước khi bắt đầu. Làm tuần tự từng công cụ, báo cáo ngắn sau mỗi công cụ.

## 0. Thông tin tôi cung cấp (tôi điền trước khi bạn chạy)

```
BASE_URL = https://...            # base URL của derouter, KHÔNG có /v1 ở cuối. Ví dụ: https://router.example.com
API_KEY  = sk-...                 # key thử, tạo riêng cho việc chụp ảnh
MODEL_TEXT = ...                  # tên một model/combo chat dùng được, lấy từ trang /account hoặc GET BASE_URL/v1/models
```

Nếu một giá trị còn trống, **dừng lại và hỏi tôi**, đừng tự đoán.

## 1. Quy tắc an toàn (bắt buộc)

1. **Không để lộ key thật trong ảnh.** Trước khi chụp, nếu màn hình hiện API key đầy đủ thì che nó: dùng chức năng ẩn của app, hoặc thay bằng `sk-xxxxxxxxxxxxxxxx` trong ô nhập trước khi chụp (rồi nhập lại key thật sau). Mọi ảnh phải hiện key ở dạng `sk-••••` hoặc `sk-xxxxxxxx`.
2. **Che luôn:** email cá nhân, token đăng nhập, đường dẫn có tên người dùng nếu không cần (thay `~` hoặc chụp cửa sổ không chứa tên máy), thông báo hệ thống, tab trình duyệt không liên quan.
3. **Không sửa cấu hình đang dùng thật của tôi mà chưa sao lưu.** Trước khi sửa bất kỳ file cấu hình nào (`~/.claude/settings.json`, `~/.codex/config.toml`, `opencode.json`, cấu hình CC Switch...), copy file đó thành `<tên>.bak-derouter` cùng thư mục. Khi xong, hỏi tôi có muốn giữ cấu hình mới hay khôi phục bản sao lưu.
4. **Hỏi tôi trước khi cài phần mềm mới** hoặc làm bất cứ thao tác nào cần mật khẩu quản trị, thanh toán, hoặc đăng nhập tài khoản.
5. **Không gửi key hay ảnh chụp lên bất kỳ dịch vụ nào.** Chỉ lưu file cục bộ.
6. Dùng **giao diện sáng**, cỡ chữ mặc định, cửa sổ rộng khoảng 1200–1400 px. Dùng tiếng Việt cho nội dung bạn gõ vào ô chat thử (câu đơn giản như "Xin chào, bạn là model nào?").
7. Nếu một bước không làm được (ứng dụng không có tính năng, giao diện khác mô tả, lỗi), **đừng bịa**. Chụp ảnh màn hình hiện trạng, ghi chú vào báo cáo và đi tiếp.

## 2. Cách chụp và đặt tên

- Lưu ảnh PNG vào `~/Desktop/derouter-screenshots/<slug>/<tên-file>.png` (tạo thư mục nếu chưa có). Tên file và slug chính xác như danh sách ở mục 4.
- Chụp **vừa đủ nội dung** cần thấy (cửa sổ ứng dụng hoặc vùng liên quan), không chụp cả màn hình có thanh dock, menu bar đầy icon. Chiều rộng tối thiểu 1000 px, rõ chữ.
- Mỗi ảnh phải **chứng minh đúng một điều** ghi ở cột "Ảnh phải thể hiện". Nếu ảnh chưa thể hiện được, chụp lại.
- Ảnh ở trạng thái **thành công** (đã cấu hình xong, đã trả lời được) trừ khi mục ghi khác.

## 3. Quy trình cho từng công cụ

Tài liệu sẽ có **hai tab cho mỗi công cụ**: "CC Switch" (nếu CC Switch hỗ trợ công cụ đó) và "Thủ công" (terminal, file cấu hình, lệnh shell). Vì vậy với mỗi công cụ bạn làm **cả hai cách** và chụp ảnh cho từng cách:

- **Thủ công:** cấu hình bằng file cấu hình, biến môi trường hoặc lệnh trong Terminal (sh/zsh). Đây là cách mặc định, luôn làm.
- **CC Switch:** chỉ làm nếu CC Switch có hỗ trợ công cụ đó (theo README chính thức ở https://github.com/farion1231/cc-switch, CC Switch hỗ trợ: Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, Hermes, Pi, MiniMax Code, Kimi Code, Oh My Pi). Nếu công cụ không có trong app, bỏ qua tab này và ghi vào báo cáo.

Trước khi đổi từ cách này sang cách kia, **khôi phục cấu hình về trạng thái ban đầu** (từ bản sao lưu) để hai cách không đè lên nhau, và xác nhận công cụ đang đi qua derouter (xem lượt dùng mới ở trang `/usage` của key).

Với mỗi công cụ: (a) đọc tài liệu chính thức của nó để làm đúng với phiên bản đang cài, (b) cấu hình, (c) chạy một yêu cầu thử, (d) chụp các ảnh ở mục 4, (e) ghi **phiên bản** và **các bước thực tế** (kể cả chỗ khác mô tả dưới đây) vào báo cáo.

Giá trị chung:

- OpenAI-compatible: base URL = `BASE_URL/v1`, key = `API_KEY`.
- Anthropic-compatible (Claude Code, Claude Desktop): base URL = `BASE_URL` (không có `/v1`), key = `API_KEY`.
- Tên model: `MODEL_TEXT` (danh sách model lấy từ `BASE_URL/v1/models`).

### 3.0 Cài CC Switch (slug `cc-switch`)
Hỏi tôi trước khi cài. Trên macOS: `brew install --cask cc-switch` (hoặc tải `.dmg` ở trang Releases của https://github.com/farion1231/cc-switch). Mở app, chụp màn hình cài đặt/giới thiệu, nút "+" (Add Provider) và danh sách các công cụ nó quản lý. Cách thêm provider: bấm "+", chọn "tạo cấu hình tuỳ chỉnh" (custom), điền endpoint, key, model. Sau khi chuyển provider, một số công cụ cần khởi động lại (Claude Desktop phải thoát hẳn rồi mở lại). Với model không phải Claude, Claude Desktop cần "Model Mapping" (gán các bậc Sonnet/Opus/Haiku sang model của derouter).

### 3.1 Trang web derouter (slug `quickstart`)
Mở `BASE_URL` trên trình duyệt. Chụp trang đăng ký, trang gói, trang tạo key (**tạo key mới tên `docs-demo`, che key trước khi chụp**), nơi hiển thị base URL (trang `/account` hoặc đầu trang chủ), và trang `/usage` đã nạp key (che key). Sau đó chạy `curl` gọi `POST BASE_URL/v1/chat/completions` trong Terminal và chụp kết quả (dùng biến `$API_KEY`, đừng in key ra).

### 3.2 Claude Code (slug `claude-code`)
- Thủ công: biến môi trường `ANTHROPIC_BASE_URL` và `ANTHROPIC_AUTH_TOKEN`, hoặc mục `env` trong `~/.claude/settings.json`. Chạy `claude`, hỏi một câu thử.
- CC Switch: thêm provider cho Claude Code, bật nó, mở lại Claude Code và hỏi một câu.

### 3.3 Claude Desktop (slug `claude-desktop`)
- CC Switch (cách thực tế): thêm provider cho Claude Desktop, tạo Model Mapping nếu cần, thoát hẳn Claude Desktop rồi mở lại, trò chuyện thử.
- Thủ công: xem tài liệu chính thức của Claude Desktop về cổng/inference bên thứ ba cho phiên bản đang cài. Nếu có cách cấu hình thủ công chính thức, làm và chụp; nếu **không có**, ghi rõ trong báo cáo và đừng dùng cách không chính thức.

### 3.4 Codex CLI (slug `codex`)
- Thủ công: `~/.codex/config.toml` với một `model_provider` trỏ tới `BASE_URL/v1` (đúng `wire_api` mà phiên bản đang cài yêu cầu), key qua biến môi trường. Chạy `codex`, hỏi thử.
- CC Switch: thêm provider cho Codex, bật, chạy `codex`, hỏi thử.

### 3.5 OMP / Oh My Pi (slug `omp`)
- Thủ công: đọc tài liệu chính thức của OMP để biết cách thêm provider tương thích OpenAI (file cấu hình hoặc lệnh). Cấu hình, chạy, hỏi thử.
- CC Switch: thêm provider cho Oh My Pi, bật, chạy OMP, hỏi thử.

### 3.6 OpenCode (slug `opencode`)
- Thủ công: `opencode.json` với provider tương thích OpenAI và `baseURL` = `BASE_URL/v1`. Chạy `opencode`, hỏi thử.
- CC Switch: thêm provider cho OpenCode, bật, chạy, hỏi thử.

### 3.8 SDK (slug `sdk`)
Trong một thư mục tạm, cài SDK `openai` cho Python, chạy một script nhỏ gọi chat completions (một lần thường, một lần `stream=True`), key lấy từ biến môi trường. Chụp terminal hai lần chạy.

## 4. Danh sách ảnh phải chụp (tên file là bắt buộc)

| Slug | File | Ảnh phải thể hiện |
|---|---|---|
| quickstart | `01-register.png` | Trang đăng ký tài khoản derouter |
| quickstart | `02-plans.png` | Trang các gói để mua hoặc đổi mã quà tặng |
| quickstart | `03-create-key.png` | Trang API key sau khi tạo key `docs-demo` (key đã che) |
| quickstart | `04-base-url.png` | Nơi hiển thị base URL để sao chép |
| quickstart | `05-usage-page.png` | Trang `/usage` với key đã nạp (che key), thấy bảng model có sẵn |
| quickstart | `06-curl-response.png` | Terminal: lệnh `curl` và phản hồi JSON thành công |
| cc-switch | `01-install.png` | CC Switch vừa cài, màn hình chính |
| cc-switch | `02-add-provider.png` | Dialog thêm provider (nút "+" và form tuỳ chỉnh) |
| cc-switch | `03-tools-list.png` | Danh sách các công cụ CC Switch quản lý |
| claude-code | `manual-01-settings.png` | `settings.json` hoặc biến môi trường trỏ tới derouter (key che) |
| claude-code | `manual-02-running.png` | Claude Code trả lời một câu thử |
| claude-code | `ccswitch-01-provider-form.png` | Form provider cho Claude Code trong CC Switch (key che) |
| claude-code | `ccswitch-02-active.png` | Provider derouter đang được bật |
| claude-code | `ccswitch-03-running.png` | Claude Code trả lời sau khi chuyển bằng CC Switch |
| claude-desktop | `ccswitch-01-add-provider.png` | Thêm provider cho Claude Desktop trong CC Switch |
| claude-desktop | `ccswitch-02-model-mapping.png` | Màn hình Model Mapping |
| claude-desktop | `ccswitch-03-chat-working.png` | Claude Desktop trò chuyện chạy qua derouter |
| claude-desktop | `manual-01-settings.png`, `manual-02-chat-working.png` | **Chỉ chụp nếu** có cách cấu hình thủ công chính thức |
| codex | `manual-01-config.png` | `config.toml` với provider derouter |
| codex | `manual-02-running.png` | Codex trả lời |
| codex | `ccswitch-01-provider-form.png` | Form provider cho Codex trong CC Switch (key che) |
| codex | `ccswitch-02-running.png` | Codex trả lời sau khi chuyển bằng CC Switch |
| omp | `manual-01-config.png` | Cấu hình provider của OMP |
| omp | `manual-02-running.png` | OMP trả lời |
| omp | `ccswitch-01-provider-form.png` | Form provider cho Oh My Pi trong CC Switch (key che) |
| omp | `ccswitch-02-running.png` | OMP trả lời sau khi chuyển bằng CC Switch |
| opencode | `manual-01-config.png` | `opencode.json` với provider derouter |
| opencode | `manual-02-running.png` | OpenCode trả lời |
| opencode | `ccswitch-01-provider-form.png` | Form provider cho OpenCode trong CC Switch (key che) |
| opencode | `ccswitch-02-running.png` | OpenCode trả lời sau khi chuyển bằng CC Switch |
| plans | `01-queue.png` | Trang Gói của tôi với hàng đợi gói, mỗi gói có credit còn lại, hạn dùng và nút đổi thứ tự |
| plans | `02-ledger.png` | Trang Nhật ký credit với các dòng trừ credit, mỗi dòng ghi gói và số tiền |
| sdk | `01-python-sdk.png` | Terminal: script Python gọi chat completions |
| sdk | `02-streaming.png` | Terminal: cùng script với `stream=True` |

## 5. Báo cáo cuối

Khi xong, lưu `~/Desktop/derouter-screenshots/REPORT.md` và tóm tắt cho tôi, gồm:

1. Bảng: công cụ, phiên bản đã dùng, kết quả (chạy được / không chạy được / không hỗ trợ), ảnh đã chụp.
2. Với mỗi công cụ: **các bước thực tế** bạn đã làm (đường dẫn file cấu hình, nội dung đã sửa với key che), và **mọi chỗ khác với mô tả ở mục 3** (tên menu khác, tính năng không có, lỗi gặp phải và cách xử lý).
3. Ảnh nào còn thiếu hoặc chưa đạt, và lý do.
4. Nhắc tôi những file cấu hình đã sao lưu (`*.bak-derouter`) để khôi phục nếu cần.
5. Nhắc tôi **xoá key `docs-demo`** ở trang tài khoản sau khi dùng xong.

Không cần chỉnh sửa gì khác trên máy.
