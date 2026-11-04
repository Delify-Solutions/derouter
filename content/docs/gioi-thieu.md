---
slug: gioi-thieu
title: Giới thiệu bạn bè
section: Tham khảo
excerpt: Đường dẫn giới thiệu, hoa hồng trên đơn đã thanh toán, thời gian giữ tiền, rút tiền và mã quà tặng cho người mới.
summary: Cách nhận hoa hồng khi giới thiệu người mua mới, ví hoa hồng hai đơn vị tiền và quy trình rút tiền.
sortOrder: 240
# Draft until the affiliate program is switched on: publish it from the admin docs page.
published: false
---

Trang này dành cho chương trình giới thiệu. Nếu quản trị viên chưa bật chương trình, mục Giới thiệu không xuất hiện trong tài khoản của bạn.

## Đường dẫn giới thiệu

Mở mục Giới thiệu trong tài khoản. Lần đầu mở, hệ thống tạo cho bạn một mã ngắn và một đường dẫn dạng `https://YOUR-DOMAIN/r/ABCDEF`. Mã không đổi trong suốt đời tài khoản.

Chia sẻ đường dẫn đó. Người mở đường dẫn được ghi nhớ trong 30 ngày (quản trị viên có thể đổi), nên họ đăng ký lúc nào trong khoảng đó vẫn được tính là do bạn giới thiệu. Người đã có tài khoản không được ghi nhận qua đường dẫn.

## Hoa hồng

Hoa hồng tính trên số tiền người được giới thiệu thực trả, theo tỷ lệ bạn thấy ở trang Giới thiệu, và chỉ cho một số đơn đầu tiên của mỗi người:

- Hoa hồng tính lúc đơn được ghi nhận đã thanh toán, không phải lúc đặt.
- Đơn trả bằng VND nhận hoa hồng bằng đồng. Đơn trả bằng USDT hoặc USD nhận hoa hồng bằng USD. Hai đơn vị tiền giữ riêng, không quy đổi.
- Số tiền làm tròn xuống tới đơn vị nhỏ nhất.
- "Số đơn đầu" đếm mọi đơn đã thanh toán của người đó, kể cả đơn thanh toán lúc chương trình tạm tắt hoặc tài khoản của bạn đang bị khóa. Đơn bị hoàn tiền không tính, nên đơn kế tiếp được nhận suất đó.

Ví dụ: tỷ lệ 10% và khách trả 250.000đ thì hoa hồng là 25.000đ.

## Thời gian giữ tiền

Hoa hồng mới ở trạng thái Đang giữ và chưa rút được. Sau số ngày giữ (mặc định 7 ngày) tính từ lúc ghi nhận, khoản đó chuyển sang Khả dụng và cộng vào số dư. Thời gian giữ của mỗi khoản được chốt lúc ghi nhận, nên đổi cấu hình sau đó không làm thay đổi khoản đã có.

Nếu đơn bị hoàn tiền, khoản hoa hồng của đơn đó bị thu hồi. Khoản còn đang giữ thì biến mất; khoản đã cộng vào số dư thì bị trừ lại, và số dư có thể âm. Số dư âm chặn rút tiền cho tới khi hoa hồng mới bù lại.

## Rút tiền

Trước lần rút đầu, lưu thông tin nhận tiền: với VND là tên ngân hàng, số tài khoản và chủ tài khoản; với USD là mạng (TRC20, BEP20 hoặc Binance Pay) và địa chỉ ví hoặc Binance ID.

Mỗi lần rút cần:

- chương trình đang bật;
- số tiền không nhỏ hơn mức tối thiểu của đơn vị đó (nhập VND theo đồng, ví dụ 200.000; nhập USD theo đô, ví dụ 12.50);
- không vượt quá số dư khả dụng;
- không có lệnh rút nào khác đang chờ xử lý cùng đơn vị tiền.

Số tiền được giữ ngay khi gửi lệnh. Quản trị viên chuyển khoản rồi đánh dấu Đã chuyển kèm mã giao dịch, hoặc Từ chối kèm lý do; bị từ chối thì số tiền trở lại ví.

## Mã quà tặng cho người mới

Nếu chương trình có mã quà tặng chào mừng, đường dẫn giới thiệu hiển thị mã đó cho người mở link và trang đăng ký nhắc họ nhập sau khi tạo tài khoản. Mã người mới yêu cầu liên kết Telegram và mỗi tài khoản chỉ dùng một mã người mới.

## Bị khóa

Quản trị viên có thể khóa một tài khoản giới thiệu. Khi bị khóa, đường dẫn không ghi nhận người mới, không phát sinh hoa hồng mới và không gửi được lệnh rút. Số dư và lịch sử vẫn được giữ.
