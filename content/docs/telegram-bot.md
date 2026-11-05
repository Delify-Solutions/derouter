---
slug: telegram-bot
title: Bot Telegram
section: Tham khảo
excerpt: Liên kết Telegram, xem số dư, nhập mã quà, mua gói và nhận thông báo ngay trong bot.
summary: Các lệnh của bot Telegram và cách dùng để xem tài khoản, nhập mã quà, mua gói và bật tắt thông báo.
sortOrder: 225
---

Bot Telegram cho bạn xem tài khoản, nhập mã quà và mua gói mà không cần mở trang web. Bot chỉ trả lời trong chat riêng với bot, không trả lời trong nhóm.

## Liên kết Telegram

Bot chỉ biết bạn là ai sau khi Telegram đã liên kết với tài khoản:

1. Đăng nhập trang web, vào **Tài khoản**.
2. Bấm **Liên kết Telegram**. Telegram mở bot, bấm **Mở** để xác nhận.
3. Quay lại bot và gõ `/help`.

Mỗi tài khoản Telegram chỉ liên kết với một tài khoản. Muốn gỡ, dùng `/settings` trong bot hoặc trang **Tài khoản** trên web.

## Các lệnh

| Lệnh | Việc làm |
| --- | --- |
| `/help` | Danh sách lệnh và menu nút bấm |
| `/me` | Credit khả dụng, gói đang dùng, hạn dùng, khoản nợ nếu có |
| `/usage` | Số request và credit đã dùng hôm nay, 7 ngày, các model dùng nhiều nhất |
| `/gifts` | Mã quà đang mở cho bạn, bấm **Nhận** để cộng ngay |
| `/gift MÃ` | Nhập một mã quà, ví dụ `/gift WELCOME2026` |
| `/plans` | Bảng giá, bấm **Mua** để mua gói ngay trong bot |
| `/myorders` | Đơn hàng gần đây, thanh toán lại hoặc hủy đơn chưa trả |
| `/keys` | Danh sách API key (chỉ hiện phần đầu của key) |
| `/settings` | Bật hoặc tắt từng loại thông báo, gỡ liên kết |
| `/id` | Telegram ID của bạn |

Bạn cũng có thể bấm nút **Menu** cạnh ô nhập tin nhắn để chọn lệnh.

## Mua gói trong bot

1. Gõ `/plans`, bấm **Mua** ở gói muốn mua.
2. Chọn cách thanh toán: chuyển khoản VietQR hoặc Binance Pay (USDT).
3. Bot gửi thông tin thanh toán:
   - **VietQR**: ảnh QR cùng ngân hàng, số tài khoản, số tiền và nội dung chuyển khoản. Quét QR bằng app ngân hàng, hoặc chép từng dòng. Giữ đúng nội dung chuyển khoản, sai nội dung thì hệ thống không tự kích hoạt được.
   - **Binance Pay**: Pay ID, số USDT và mã cần ghi vào ô Note.
4. Khi tiền về, gói được kích hoạt tự động và bot nhắn báo cho bạn. Bấm **Kiểm tra thanh toán** để xem trạng thái bất cứ lúc nào.

Mỗi đơn có hạn thanh toán ghi trong tin nhắn. Bấm **Mua** lần nữa với cùng gói và cùng cách thanh toán thì bot gửi lại đơn đang chờ, không tạo đơn mới. Không muốn mua nữa thì bấm **Hủy đơn**.

Gói **nạp số tiền tùy ý**: sau khi bấm **Mua**, chọn nhanh **1 gói** hoặc **2 gói (x2)**, hoặc bấm **Nhập số tiền** rồi trả lời bot bằng số tiền (ví dụ `500000`, `500k` hoặc `1.5tr`). Bot báo số credit nhận được rồi mới cho chọn cách thanh toán.

Bot mua một kỳ của gói. Mua nhiều kỳ một lúc và dùng voucher thì mua trên trang **Gói của tôi**.

## Nhập mã quà

Gõ `/gift MÃ` hoặc mở `/gifts` rồi bấm **Nhận**. Mã được áp dụng y như khi nhập trên web.

Mã **tham gia kênh** cần bạn đang ở trong kênh Telegram của chúng tôi, bằng đúng tài khoản Telegram đã liên kết. Nếu bot báo bạn chưa ở trong kênh, bấm **Mở kênh Telegram**, tham gia, rồi bấm **Thử lại**.

## Thông báo

Bot nhắn cho bạn khi đơn hàng được thanh toán, khi được tặng gói, khi gói sắp hết hạn hoặc sắp hết credit, cùng các thông báo chung. Gõ `/settings` để tắt từng loại. Cảnh báo bảo mật (đăng nhập mới, đổi mật khẩu) luôn được gửi.

Nếu bạn chặn hoặc xóa bot, thông báo tạm dừng. Mở lại bot, bấm **Start** (hoặc gửi bất kỳ lệnh nào) là thông báo được gửi lại như cũ.
