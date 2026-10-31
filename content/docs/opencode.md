---
slug: opencode
title: OpenCode
section: Kết nối công cụ
excerpt: Thêm router làm provider tương thích OpenAI trong opencode.json.
summary: Cấu hình OpenCode bằng CC Switch hoặc bằng provider @ai-sdk/openai-compatible trong opencode.json.
sortOrder: 140
---

OpenCode dùng AI SDK, nên router được khai báo như một provider tương thích OpenAI với `baseURL` trỏ vào `/v1`.

> **Đã kiểm tra** với OpenCode 1.19.5 và tài liệu chính thức tại opencode.ai/docs (providers, config), ngày 31/10/2026. Schema mới nhất của OpenCode đánh dấu khóa `provider` là deprecated và giới thiệu khóa `providers` (dùng `package` thay cho `npm`). Các trang tài liệu ổn định vẫn mô tả `provider` và `npm`, và trang này làm theo đó. Tài liệu không nói rõ hai khóa liên hệ với nhau thế nào. Nếu OpenCode báo cấu hình không hợp lệ, so với schema tại https://opencode.ai/config.json.

Bạn cần API key (xem [Bắt đầu nhanh](/docs/quickstart)) và tên một model trong `/v1/models`. `MODEL-ID` bên dưới là tên đó.

:::tabs
::tab[CC Switch]
Với OpenCode, CC Switch chạy ở chế độ cùng tồn tại: nó thêm provider vào `~/.config/opencode/opencode.json`, còn việc chọn model bạn làm trong OpenCode. Cài CC Switch theo [hướng dẫn](/docs/cc-switch) trước.

1. Trong thanh bên trái, chọn **OpenCode**.
2. Nhấn **+** (Add Provider), chọn preset **OpenAI Compatible** (hoặc **Custom Configuration**).
3. Điền endpoint là `https://YOUR-DOMAIN/v1`, API key là key `sk-...` của bạn, và thêm model có tên `MODEL-ID`. Trong bản 4.0.22, mỗi model có công tắc cho thinking và đầu vào ảnh, cùng ô cho độ dài ngữ cảnh và đầu ra tối đa. Hãy điền theo thông số model của bạn.

![Form thêm provider OpenAI Compatible cho OpenCode trong CC Switch, đã điền endpoint, API key và một model](/docs-img/opencode/ccswitch-01-provider-form.png)

4. Nhấn **Add**. Với OpenCode, nút này ghi provider vào tệp cấu hình ngay. OpenCode không có nút Switch và không có chuyển đổi từ khay hệ thống.
5. Đóng terminal đang chạy OpenCode, mở lại, rồi gõ `/models` và chọn model của provider vừa thêm.

![OpenCode đang chạy, danh sách /models có model của provider vừa thêm và một phản hồi thành công](/docs-img/opencode/ccswitch-02-running.png)

CC Switch không mô tả tên các ô trong form OpenCode trong tài liệu của họ, nên nếu nhãn khác với trên, hãy dựa vào ý nghĩa: endpoint là `baseURL`, key là `apiKey`.

::tab[Thủ công]
OpenCode đọc `~/.config/opencode/opencode.json` (toàn cục) và `opencode.json` ở thư mục gốc dự án. Hai tệp được gộp, dự án ghi đè toàn cục.

Tạo hoặc sửa tệp toàn cục:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "derouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "derouter",
      "options": {
        "baseURL": "https://YOUR-DOMAIN/v1",
        "apiKey": "{env:DEROUTER_API_KEY}"
      },
      "models": {
        "MODEL-ID": {
          "name": "Tên hiển thị của model"
        }
      }
    }
  }
}
```

![Tệp ~/.config/opencode/opencode.json mở trong trình soạn thảo với provider derouter](/docs-img/opencode/manual-01-config.png)

Đặt key vào biến môi trường (cú pháp `{env:TÊN_BIẾN}` đọc biến này; biến không tồn tại cho ra chuỗi rỗng):

```bash
export DEROUTER_API_KEY=sk-YOUR-KEY
```

Mở OpenCode trong thư mục dự án, gõ `/models` và chọn `derouter/MODEL-ID`. Id đầy đủ của model luôn có dạng `<id provider>/<id model>`. Để đặt làm mặc định, thêm `"model": "derouter/MODEL-ID"` ở cấp cao nhất của `opencode.json`.

![OpenCode đang chạy với model derouter/MODEL-ID đã chọn, trả lời một yêu cầu](/docs-img/opencode/manual-02-running.png)

Thay vì `apiKey` trong tệp, bạn có thể lưu key bằng lệnh `/connect` trong OpenCode (chọn **Other**, nhập id provider là `derouter`, rồi nhập key). Lệnh này chỉ lưu key. Bạn vẫn cần khối `provider` ở trên, và id phải trùng khớp.

Tùy chọn thêm:

- `limit` trong từng model (`context`, `output`) khai báo giới hạn token của model. Điền theo thông số model của bạn.
- Nếu model chạy qua `/v1/responses`, tài liệu OpenCode hướng dẫn dùng `@ai-sdk/openai` thay cho `@ai-sdk/openai-compatible`. Trang này chưa kiểm chứng cấu hình đó trên router.
:::

## Khi gặp lỗi

- OpenCode không liệt kê model: kiểm tra id provider trong `provider` và model trong `models` đúng chính tả, và JSON hợp lệ.
- Lỗi 401: biến `DEROUTER_API_KEY` chưa được export trong cùng terminal, nên `apiKey` thành chuỗi rỗng.
- Lỗi 404: `baseURL` thiếu `/v1`, hoặc tên model không có trong `/v1/models`.
- Lỗi 402, 403, 429 từ router: xem [Bắt đầu nhanh](/docs/quickstart).
