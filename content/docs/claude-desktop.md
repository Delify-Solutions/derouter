---
slug: claude-desktop
title: Claude Desktop
section: Kết nối công cụ
excerpt: Chạy Claude Desktop qua gateway của bạn bằng chế độ third-party inference.
summary: Claude Desktop đã đăng nhập claude.ai không nhận base URL tùy chỉnh. Trang này nói rõ hai cách hợp lệ: cấu hình third-party inference thủ công, hoặc dùng CC Switch.
sortOrder: 120
---

Claude Desktop bình thường, đăng nhập bằng tài khoản claude.ai, không cho đổi base URL hay API key. Muốn dùng router, bạn phải chạy app ở chế độ third-party inference (gọi tắt là 3P). Ở chế độ này, mọi request của app đi qua gateway bạn cấu hình, và bạn không đăng nhập tài khoản Anthropic.

> **Đã kiểm tra** với tài liệu chính thức "Claude Desktop on third-party" tại claude.com/docs/third-party/claude-desktop (overview, gateway, configuration), ngày 31/10/2026. Tài liệu không ghi số phiên bản Desktop tối thiểu, nên trang này không nêu phiên bản. Tài liệu nhắm tới tổ chức, nhưng cấu hình cho một máy không cần quyền quản trị hay MDM.

Ba điều cần biết trước khi làm:

- Gateway phải hỗ trợ `POST /v1/messages` có streaming và tool use. Router đáp ứng điều này.
- Tab Code trong Claude Desktop không đọc `ANTHROPIC_BASE_URL` hay `~/.claude/settings.json`. Nó lấy cấu hình từ chính chế độ 3P. Muốn dùng biến môi trường riêng, hãy dùng [Claude Code CLI](/docs/claude-code).
- Chế độ 3P được thiết kế cho model Claude. Anthropic không hỗ trợ chính thức việc chạy model không phải Claude qua gateway. Phần ánh xạ model bên dưới là cách để làm được việc đó, nhưng một số tính năng có thể khác bản gốc.

:::tabs
::tab[CC Switch]
CC Switch tạo và chuyển hồ sơ 3P giúp bạn, nên không phải mở cửa sổ cấu hình của Claude Desktop. Cài CC Switch theo [hướng dẫn](/docs/cc-switch) trước.

CC Switch có hai chế độ kết nối cho Claude Desktop:

- **Direct**: dùng khi tên model của bạn là tên model Claude (`claude-sonnet-*`, `claude-opus-*`, `claude-haiku-*`). Claude Desktop gọi thẳng tới router.
- **Model mapping**: dùng khi tên model không phải Claude. CC Switch chạy một cổng cục bộ tại `http://127.0.0.1:15721/claude-desktop` và ánh xạ ba vai trò Sonnet, Opus, Haiku của Claude Desktop sang model thật của bạn.

Hãy mở `/v1/models` để xem model của bạn thuộc dạng nào. Với router này, thường bạn cần Model mapping.

1. Trong thanh bên trái của CC Switch, chọn **Claude Desktop** (không phải Claude). Nếu không thấy, vào trang Apps và bật mục này.
2. Nhấn nút **Add Provider** ở góc trên bên phải, chọn **Custom configuration**.
3. Điền tên, endpoint URL là `https://YOUR-DOMAIN` và API key là key `sk-...` của bạn.

![Cửa sổ Add Provider của CC Switch, tab Claude Desktop, đã điền tên, endpoint URL và API key](/docs-img/claude-desktop/ccswitch-01-add-provider.png)

4. Bật **Needs model mapping**, rồi điền bảng ánh xạ:
   - **Model role**: Sonnet, Opus hoặc Haiku.
   - **Menu display name**: tên hiện trong menu chọn model của Claude Desktop.
   - **Requested model**: tên model thật của bạn, đúng như trong `/v1/models` (thay cho `MODEL-ID`).
   - **1M**: chỉ bật nếu model thật sự hỗ trợ ngữ cảnh 1 triệu token.

   Chỉ cần điền một vai trò. Các vai trò để trống sẽ dùng model của vai trò đầu tiên đã điền (Sonnet trước), nên các lệnh gọi sub-agent kiểu Haiku vẫn chạy.

![Bảng Model Mapping của provider, vai trò Sonnet có Menu display name và Requested model đã điền](/docs-img/claude-desktop/ccswitch-02-model-mapping.png)

5. Nhấn **Add**, rồi nhấn **Switch** trên thẻ provider. Thẻ chuyển sang **In use**. Với Model mapping, dịch vụ routing tự khởi động.
6. Thoát hẳn Claude Desktop (không chỉ đóng cửa sổ) rồi mở lại. Claude Desktop không tự nạp lại cấu hình.

![Claude Desktop sau khi mở lại, menu chọn model hiện tên đã đặt và một hội thoại trả lời thành công](/docs-img/claude-desktop/ccswitch-03-chat-working.png)

Khi dùng Model mapping, hãy để CC Switch chạy suốt lúc dùng Claude Desktop. Ở chế độ Direct bạn có thể tắt CC Switch sau khi Claude Desktop đã nạp hồ sơ.

Muốn quay về Claude Desktop thường: chọn **Claude Desktop Official**, nhấn **Switch**, rồi mở lại app.

Không sửa tay các tệp mà CC Switch ghi trong thư mục `Claude` và `Claude-3p`. Nếu chúng lệch nhau, bật lại provider hiện tại thường sửa được.

::tab[Thủ công]
Đây là cách chính thức của Anthropic, dùng cửa sổ cấu hình có sẵn trong app.

1. Cài Claude Desktop từ claude.com/download.
2. Mở app, **không đăng nhập** và không tạo tài khoản. Trên macOS, vào menu **Help → Troubleshooting → Enable Developer Mode**. Trên Windows, mở menu ☰ ở góc trên bên trái màn hình đăng nhập và làm tương tự.
3. Vào **Developer → Configure Third-Party Inference…**
4. Điền các giá trị sau:
   - **Inference provider**: Gateway.
   - **Gateway base URL**: `https://YOUR-DOMAIN`.
   - **Gateway API key**: key `sk-...` của bạn.
   - **Gateway auth scheme**: Bearer (mặc định) hoặc x-api-key. Router nhận cả hai.

![Cửa sổ Configure Third-Party Inference với Inference provider là Gateway, base URL và API key đã điền](/docs-img/claude-desktop/manual-01-settings.png)

5. Nhấn **Apply Changes**, rồi **Save & Restart**. Màn hình đăng nhập sau khi mở lại sẽ có lựa chọn bắt đầu Claude Desktop ở chế độ 3P với cấu hình bạn vừa nhập. Chọn nó.

![Claude Desktop ở chế độ 3P, một hội thoại gửi tin nhắn và nhận trả lời](/docs-img/claude-desktop/manual-02-chat-working.png)

Lưu ý khi cấu hình:

- Tài liệu của Anthropic không thống nhất về việc base URL có kèm `/v1` hay không (có ví dụ không có, có ví dụ có). Router nhận `/v1/messages` lẫn `/v1/v1/messages`, nên cả hai dạng đều chạy. Nếu app báo `Gateway was unreachable`, kiểm tra địa chỉ có đúng và có truy cập được từ máy bạn không.
- Sau khi app khởi động lại vào cấu hình 3P, menu Developer biến mất. Bật lại Developer Mode theo bước 2, và nó sẽ giữ nguyên.
- Danh sách model: app tự lấy từ `/v1/models`, nhưng chỉ hiện những tên nhận ra là Claude. Với model có tên khác, cần khai báo model thủ công trong cửa sổ cấu hình. Tài liệu chỉ mô tả cách khai báo bí danh cho model Claude, nên với model không phải Claude, cách dễ hơn là dùng tab CC Switch (Model mapping). Phần này chưa được kiểm chứng trên router.
- Cấu hình được lưu trong thư mục dữ liệu riêng của chế độ 3P (macOS: `~/Library/Application Support/Claude-3p/configLibrary/`, Windows: `%LOCALAPPDATA%\Claude-3p\configLibrary\`). Hãy sửa qua cửa sổ cấu hình, không sửa tay các tệp này.
- Để quay về Claude thường, chọn lựa chọn đăng nhập Anthropic ở màn hình đăng nhập.
:::

## Khi gặp lỗi

- Đã chuyển provider nhưng app không đổi: thoát hẳn Claude Desktop rồi mở lại.
- Hội thoại báo lỗi khi dùng Model mapping: kiểm tra CC Switch đang chạy, dịch vụ routing hiện Running, key và endpoint đúng, và đã điền ít nhất một Requested model.
- Direct báo lỗi: provider có thể không nhận tên model dạng Claude. Bật **Needs model mapping**.
- Lỗi 401, 402, 403, 429 từ router: xem [Bắt đầu nhanh](/docs/quickstart).
