---
slug: quickstart
title: Bắt đầu nhanh
section: Bắt đầu
excerpt: Tạo tài khoản, lấy gói, tạo API key và gửi request đầu tiên.
summary: Từ đăng ký đến request đầu tiên trong vài phút, cùng cách đọc các lỗi 401, 402, 403 và 429.
sortOrder: 10
---

Trang này đi từ đăng ký đến request đầu tiên. Các công cụ cụ thể như Claude Code hay Codex có trang riêng trong mục Kết nối công cụ.

Trong tài liệu, `https://YOUR-DOMAIN` là chỗ giữ địa chỉ của trang này. Bạn không cần đoán địa chỉ thật: nó hiện sẵn ở trang Tổng quan trong tài khoản và ngay trên trang chủ, kèm nút sao chép. Hãy thay `YOUR-DOMAIN` bằng địa chỉ đó trong mọi lệnh bên dưới.

## 1. Tạo tài khoản

Mở trang Đăng ký, nhập email và mật khẩu từ 10 ký tự trở lên. Hệ thống gửi một email xác minh. Mở liên kết trong email để kích hoạt tài khoản, vì tài khoản chưa xác minh không gọi được API.

![Trang Đăng ký với ô email và mật khẩu đã điền, nút Tạo tài khoản](/docs-img/quickstart/01-register.png)

## 2. Có một gói

Credit để gọi model nằm trong gói. Bạn có hai cách lấy gói:

- Mua gói: vào Gói của tôi, chọn gói, chọn cách trả. VietQR trả bằng VND, Binance USDT trả bằng USD. Mỗi đơn có mã thanh toán riêng, số tiền chính xác và hạn thanh toán (mặc định 30 phút). Chuyển khoản kèm đúng mã, gói được kích hoạt sau vài giây.
- Nhập mã quà tặng: vào Mã quà tặng, nhập mã và xác nhận.

![Trang Gói của tôi với danh sách gói có thể mua và nút Chọn gói](/docs-img/quickstart/02-plans.png)

Chi tiết về hàng đợi gói và hạn mức nằm ở trang [Gói, credit và hạn mức](/docs/plans).

## 3. Tạo API key

Vào API key và tạo key mới. Key bắt đầu bằng `sk-` và chỉ hiện đầy đủ một lần, ngay sau khi tạo. Hãy sao chép và lưu vào nơi an toàn. Nếu mất key, xóa key đó và tạo key mới.

![Hộp thoại sau khi tạo key, hiện secret bắt đầu bằng sk- cùng nút sao chép](/docs-img/quickstart/03-create-key.png)

Không đưa key vào mã nguồn công khai hay ảnh chụp màn hình. Ai có key đều tiêu được credit của bạn.

## 4. Lấy base URL

Base URL là địa chỉ mà công cụ của bạn gọi tới. Trang Tổng quan trong tài khoản hiển thị nó, dạng `https://YOUR-DOMAIN/v1`.

![Trang Tổng quan, mục Bắt đầu, hiện base URL và nút sao chép](/docs-img/quickstart/04-base-url.png)

Mỗi nhóm công cụ dùng địa chỉ hơi khác nhau:

| Công cụ | Base URL |
| --- | --- |
| Client theo chuẩn OpenAI (OpenAI SDK, Codex, OpenCode, OMP...) | `https://YOUR-DOMAIN/v1` |
| Client theo chuẩn Anthropic (Claude Code, Anthropic SDK) | `https://YOUR-DOMAIN` |

Với client Anthropic, server nhận cả `https://YOUR-DOMAIN` lẫn `https://YOUR-DOMAIN/v1`, nên dán nhầm dạng nào cũng chạy.

## 5. Gửi request đầu tiên

Trước tiên, liệt kê model mà tài khoản của bạn gọi được. Tên model trong kết quả là giá trị bạn điền vào trường `model`.

```bash
curl https://YOUR-DOMAIN/v1/models -H "Authorization: Bearer sk-YOUR-KEY"
```

Sau đó gọi một model. Thay `MODEL-ID` bằng một tên trong danh sách ở trên.

```bash
curl https://YOUR-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","messages":[{"role":"user","content":"Xin chào"}]}'
```

Cùng key dùng được cho giao thức Claude. Với giao thức này, key đặt trong header `x-api-key` (header `Authorization: Bearer` cũng được nhận).

```bash
curl https://YOUR-DOMAIN/v1/messages \
  -H "x-api-key: sk-YOUR-KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","max_tokens":256,"messages":[{"role":"user","content":"Xin chào"}]}'
```

![Terminal sau khi chạy lệnh curl chat/completions, hiện JSON phản hồi có trường choices](/docs-img/quickstart/06-curl-response.png)

## 6. Xem mức dùng

Mỗi request trừ credit theo giá token của model. Có hai nơi để xem:

- Trong tài khoản: Lịch sử dùng liệt kê từng request, còn Nhật ký credit ghi từng khoản trừ.
- Trang `/usage`: dán API key vào ô tìm kiếm, không cần đăng nhập. Trang hiện mức dùng và lịch sử request của riêng key đó.

![Trang /usage với API key đã dán, hiện tổng quan và bảng lịch sử request](/docs-img/quickstart/05-usage-page.png)

## Đọc lỗi

Khi router từ chối request, phản hồi luôn là JSON cùng một dạng, và `message` là một câu tiếng Việt:

```json
{
  "error": {
    "message": "Các gói đang chạm hạn mức, mở lại sau 1 giờ 12 phút",
    "type": "rate_limit_error",
    "code": "plan_limit",
    "resetAt": "2026-10-31T14:10:00.000Z"
  }
}
```

Hãy xử lý theo `code`, không theo nội dung `message`.

| HTTP | `code` | Ý nghĩa | Việc cần làm |
| --- | --- | --- | --- |
| 401 | `invalid_api_key` | Key sai hoặc đã bị tắt | Kiểm tra key, tạo key mới nếu cần |
| 402 | `insufficient_quota` | Không còn gói nào có credit | Mua gói hoặc nhập mã quà tặng |
| 403 | `key_expired` | Key đã quá hạn | Tạo key mới |
| 403 | `account_suspended` | Tài khoản bị khóa | Liên hệ quản trị viên |
| 403 | `account_unverified` | Chưa xác minh email | Mở liên kết trong email xác minh |
| 403 | `model_not_allowed` | Model nằm ngoài nhóm của bạn | Chọn model có trong `/v1/models` |
| 429 | `rate_limit` | Vượt số request hoặc token mỗi phút của gói | Chờ theo header `Retry-After` (60 giây) |
| 429 | `plan_limit` | Mọi gói còn credit đều chạm hạn mức theo khung giờ | Chờ đến `resetAt`, hoặc theo header `Retry-After` (giây) |

Với lỗi 429, client nên đọc header `Retry-After` để biết cần chờ bao nhiêu giây rồi thử lại. Với `plan_limit`, trường `resetAt` trong `error` cho biết thời điểm mở lại, theo giờ UTC. Lỗi 402 và 403 không tự hết: thử lại ngay vô ích cho đến khi bạn xử lý nguyên nhân.

Những lỗi khác, như 404 hoặc 500, có thể đến từ router (model sai tên, chưa có kết nối) hoặc từ model phía sau. Xem [Xử lý sự cố](/docs/troubleshooting).
