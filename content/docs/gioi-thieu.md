---
slug: gioi-thieu
title: Giới thiệu bạn bè
section: Tham khảo
excerpt: Đường dẫn giới thiệu, hoa hồng trên đơn đã thanh toán, đổi hoa hồng thành credit hoặc voucher, quà cho người được giới thiệu.
summary: Cách nhận hoa hồng khi giới thiệu người mua mới, ví hoa hồng hai đơn vị tiền và cách dùng hoa hồng.
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

Hoa hồng mới ở trạng thái Đang giữ và chưa dùng được. Sau số ngày giữ (mặc định 7 ngày) tính từ lúc ghi nhận, khoản đó chuyển sang Khả dụng và cộng vào số dư. Thời gian giữ của mỗi khoản được chốt lúc ghi nhận, nên đổi cấu hình sau đó không làm thay đổi khoản đã có.

Nếu đơn bị hoàn tiền, khoản hoa hồng của đơn đó bị thu hồi. Khoản còn đang giữ thì biến mất; khoản đã cộng vào số dư thì bị trừ lại, và số dư có thể âm. Số dư âm chặn việc đổi credit và tạo voucher cho tới khi hoa hồng mới bù lại. Credit đã đổi và voucher đã tạo không bị thu hồi.

## Dùng hoa hồng

Hoa hồng không rút ra tiền mặt. Có hai cách dùng, ở mục "Dùng hoa hồng" trong trang Giới thiệu:

- **Đổi thành credit.** Số tiền chọn được đổi thành credit dùng API: ví USD đổi 1:1, ví VND đổi theo tỷ giá quản trị viên đặt (hiện trên trang). Mỗi lần đổi là một khoản credit riêng, có hạn riêng (mặc định 30 ngày kể từ lúc đổi) và giới hạn tốc độ (RPM, TPM) theo gói quản trị viên chọn. Các lần đổi không gộp hạn với nhau.
- **Tạo voucher.** Số tiền chọn thành một mã voucher dùng một lần. Bạn gửi mã cho bất kỳ ai; người đó nhập mã ở ô "Voucher" trên trang mua gói và giá trị voucher được trừ vào giá đơn (khác đơn vị tiền thì quy đổi theo tỷ giá). Phần dư không hoàn lại. Voucher chưa dùng có thể hủy để lấy lại tiền vào ví.

Mỗi lần dùng phải từ mức tối thiểu trở lên và không vượt số dư khả dụng.

## Quà cho người được giới thiệu

Nếu quản trị viên bật, người đăng ký qua đường dẫn của bạn được tặng thêm một phần trăm credit cho một số đơn đầu đã thanh toán: phần thêm là một khoản credit riêng, hạn như credit đổi từ hoa hồng. Với gói không giới hạn credit, quà là giảm giá ngay khi tạo đơn. Mức quà hiện trên trang Giới thiệu và trên trang đăng ký.

## Mã quà tặng cho người mới

Nếu chương trình có mã quà tặng chào mừng, đường dẫn giới thiệu hiển thị mã đó cho người mở link và trang đăng ký nhắc họ nhập sau khi tạo tài khoản. Mã người mới yêu cầu liên kết Telegram và mỗi tài khoản chỉ dùng một mã người mới.

## Bị khóa

Quản trị viên có thể khóa một tài khoản giới thiệu. Khi bị khóa, đường dẫn không ghi nhận người mới, không phát sinh hoa hồng mới, người được giới thiệu không nhận quà và bạn không đổi credit hay tạo voucher được. Số dư và lịch sử vẫn được giữ.
