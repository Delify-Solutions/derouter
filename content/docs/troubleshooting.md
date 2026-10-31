---
slug: troubleshooting
title: Xử lý sự cố
section: Tham khảo
excerpt: Cách xử lý lỗi 401, 403, 404, 429, 500, context_length, request quá lớn và stream bị ngắt.
summary: Tra theo mã lỗi hoặc triệu chứng để biết nguyên nhân thường gặp và việc cần làm.
sortOrder: 230
---

Mọi lỗi do chính router tạo ra đều có dạng JSON `{ "error": { "message", "type", "code" } }`. Hãy bắt đầu bằng `code`. Bảng đầy đủ các mã 401, 402, 403 và 429 nằm ở [Bắt đầu nhanh](/docs/quickstart). Trang này tập trung vào các tình huống khó đoán hơn.

## 401: key không hợp lệ

Mã `invalid_api_key`. Kiểm tra theo thứ tự:

- Key bắt đầu bằng `sk-` và được sao chép đủ, không thừa khoảng trắng hay dấu xuống dòng.
- Key chưa bị xóa hoặc tắt trong mục API key của tài khoản.
- Key đi đúng header: `Authorization: Bearer sk-...` (giao thức OpenAI), hoặc `x-api-key: sk-...` (giao thức Claude). Router nhận cả hai ở mọi endpoint.
- Biến môi trường đã được export trong cùng terminal. Nếu biến rỗng, client gửi header rỗng và bạn nhận 401.

Công cụ như Claude Code vẫn hiện màn hình đăng nhập dù key đúng: xem trang [Claude Code](/docs/claude-code).

## 403: bị từ chối

Có bốn mã khác nhau, và mỗi mã có cách xử lý riêng:

- `model_not_allowed`: model nằm ngoài nhóm của bạn. Chọn một model trong `/v1/models`.
- `key_expired`: key đã quá hạn. Tạo key mới.
- `account_unverified`: bạn chưa mở liên kết trong email xác minh.
- `account_suspended`: tài khoản đang bị khóa. Liên hệ quản trị viên.

## 404 hoặc 400: không tìm thấy model

Hai thông báo thường gặp: `Invalid model format` (HTTP 400) khi tên model không khớp bất kỳ combo nào, và `No active credentials for provider: ...` (HTTP 404) khi combo trỏ tới một nguồn hiện không hoạt động. Cách xử lý:

1. Gọi `GET /v1/models` và so tên bằng mắt. Tên phải khớp từng ký tự.
2. Công cụ hay thêm hoặc đổi tên model: Claude Code dùng tên model Claude cho tác vụ nền nếu bạn chưa đặt `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Xem [Claude Code](/docs/claude-code).
3. Với `No active credentials for provider`, lỗi nằm ở phía máy chủ. Gửi tên model và thời điểm cho quản trị viên.

Base URL sai cũng cho 404 trên mọi request. Client OpenAI cần `https://YOUR-DOMAIN/v1`, client Anthropic dùng `https://YOUR-DOMAIN`.

## 429: quá nhiều request

Có hai mã, và cách chờ khác nhau:

- `rate_limit`: vượt số request hoặc token mỗi phút của gói. Chờ 60 giây (header `Retry-After`). Nhiều key cùng tài khoản dùng chung một hạn mức, nên thêm key không giúp tăng giới hạn.
- `plan_limit`: mọi gói còn credit đều chạm hạn mức theo khung giờ. Chờ đến `resetAt`, hoặc mua thêm gói để có hàng đợi dài hơn. Xem [Gói, credit và hạn mức](/docs/plans).

Client tự động chờ theo `Retry-After` là cách xử lý đúng. Đừng thử lại liên tục khi chưa tới thời điểm mở lại.

## 500 và các lỗi 5xx

Lỗi 5xx thường đến từ model phía sau, hoặc nhà cung cấp của model đang quá tải hay không phản hồi. Router có thể tự thử lại hoặc chuyển model trong combo, nên lỗi lọt tới bạn thường là lỗi kéo dài.

- Thử lại sau vài giây, với cùng yêu cầu.
- Thử một model khác trong `/v1/models` để biết lỗi riêng một model hay chung.
- Nếu lỗi lặp lại, gửi cho quản trị viên thời điểm xảy ra, tên model và nội dung `message` trong phản hồi.
- Credit chỉ được trừ khi request hoàn tất. Nếu nghi ngờ một request lỗi vẫn bị trừ, kiểm tra Nhật ký credit.

## context_length: vượt giới hạn ngữ cảnh

Khi prompt cộng với phần trả lời tối đa vượt cửa sổ ngữ cảnh của model, nhà cung cấp trả lỗi 400, 413 hoặc 422 có thông báo nhắc tới `context_length`, độ dài prompt hoặc giới hạn kích thước. Router chuyển nguyên trạng mã trạng thái và thông báo đó cho bạn. Lỗi này thuộc về request chứ không thuộc về tài khoản: các request khác vẫn chạy bình thường ngay sau đó.

Cách xử lý:

- Rút ngắn hội thoại, hoặc bắt đầu một phiên mới. Công cụ lập trình thường có lệnh nén hội thoại (như `/compact` trong Claude Code).
- Giảm `max_tokens` hoặc `max_completion_tokens`: phần này cũng chiếm chỗ trong cửa sổ.
- Chọn model có cửa sổ ngữ cảnh lớn hơn.
- Với Claude Code, đặt kích thước ngữ cảnh đúng với model. Xem mục "Ngữ cảnh dài" ở [Claude Code](/docs/claude-code).

Nếu combo có nhiều model, router có thể thử model kế tiếp sau lỗi kích thước. Chỉ khi mọi model đều từ chối bạn mới nhận lỗi.

## Request quá lớn

Server giới hạn kích thước body của một request. Ảnh base64 và hội thoại rất dài là hai nguyên nhân thường gặp. Giới hạn cụ thể do quản trị viên máy chủ đặt, nên trang này không nêu con số.

- Dùng URL ảnh thay cho dữ liệu base64, hoặc giảm độ phân giải.
- Cắt bớt lịch sử hội thoại hoặc tệp đính kèm.
- Nếu máy chủ nằm sau một reverse proxy khác (như nginx), proxy đó cũng có giới hạn riêng (`client_max_body_size`).

Với request lớn, router chờ nhà cung cấp lâu hơn trước khi bỏ cuộc: thời gian chờ phản hồi bắt đầu ở 60 giây và tăng theo kích thước body, tối đa 300 giây. Request nào hết thời gian chờ này không được gửi lại tới cùng nguồn, vì gửi lại prompt lớn chỉ làm nguồn đó quá tải thêm.

## Stream bị ngắt giữa chừng

Triệu chứng: phản hồi dừng giữa câu, client báo kết nối bị đóng hoặc thiếu sự kiện kết thúc.

- Reverse proxy hoặc CDN trước máy chủ đang giữ đệm (buffering) hoặc cắt kết nối rảnh quá lâu. Với nginx, tắt `proxy_buffering` và tăng `proxy_read_timeout` cho đường dẫn `/v1`.
- Client có thời gian chờ ngắn hơn thời gian model suy luận. Tăng timeout của client (Claude Code dùng `API_TIMEOUT_MS`), hoặc giảm mức thinking.
- Mạng di động hoặc VPN cắt kết nối rảnh: dùng streaming, vì các đoạn dữ liệu liên tục giữ kết nối sống.
- Request lỗi ở nhà cung cấp giữa chừng: thử lại. Với SDK, bắt lỗi kết nối và gọi lại.

Khi bị ngắt, phần bạn nhận được chỉ là đầu của câu trả lời. Hãy kiểm tra Nhật ký credit để biết request đó có bị trừ credit hay không.

## Vẫn chưa xử lý được

Mở trang `/usage`, dán API key và tìm request lỗi trong lịch sử để biết mã trạng thái và thời điểm. Gửi các thông tin này cho quản trị viên: thời điểm, tên model, endpoint, mã trạng thái, và `message` trong phản hồi. Không gửi API key.
