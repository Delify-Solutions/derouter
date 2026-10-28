# derouter — mô tả sản phẩm

Tài liệu gốc mô tả website mong muốn, đã được chủ dự án xác nhận ngày 29/10/2026. Chi tiết kỹ thuật nằm trong `openspec/changes/billing-v2-plan-queue/` (GĐ0–GĐ4) và `openspec/changes/payment-gateways/` (GĐ5). Khi tài liệu này và spec mâu thuẫn, hỏi chủ dự án trước khi code.

## Website này là gì

Trang bán gói dùng AI kiểu OpenCode Go. Khách đăng ký, mua gói, lấy API key rồi dùng trong công cụ lập trình (Claude Code, OpenCode, Codex…) để gọi nhiều model AI qua một địa chỉ API duy nhất. Tiền dùng AI trừ vào gói đã mua.

## Phía khách hàng

**1. Xem trang chủ (landing)**
- Mỗi gói hiện: giá VND (chuyển khoản), giá USD (Binance), số credit nhận được dùng chung mọi model (vd $250), thời hạn (vd 30 ngày) và các hạn mức (vd "tối đa $20 mỗi 5 giờ").
- Danh sách model đúng với những gì khách mới đăng ký được dùng, kèm giá token.
- Giải thích credit trừ theo giá token (model đắt hết nhanh hơn) và FAQ.
- Bấm "Chọn gói" → đăng ký / đăng nhập → quay về đúng gói vừa chọn.

**2. Đăng ký**
- Email + mật khẩu (tối thiểu 10 ký tự), xác minh qua email, có giới hạn chống spam.
- Tài khoản mới tự vào group mặc định. Group quyết định model nào được gọi và RPM/TPM.

**3. Mua gói**
- Chọn gói, chọn cách trả: **VietQR** (VND), **Binance USDT** (USD), hoặc **thủ công** (admin duyệt, dự phòng).
- Mỗi đơn có mã thanh toán riêng, số tiền chính xác, hạn 30 phút. Trang đơn hiện QR, các ô copy, đồng hồ đếm ngược.
- Khách chuyển kèm đúng mã → hệ thống tự nhận biết (SePay, web2m, ACB hoặc Binance) → gói kích hoạt và vào hàng đợi trong vài giây.

**4. Dùng nhiều gói (hàng đợi)**
- Mỗi lần mua hoặc được tặng là một gói riêng, có credit, hạn và hạn mức riêng.
- Gọi AI thì trừ vào gói đầu hàng đợi. Gói đó hết credit, hết hạn hoặc chạm hạn mức (vd đã tiêu $20 trong 5 giờ) thì tự chuyển sang gói kế tiếp.
- Hạn mức tính từ lần dùng đầu; đủ thời gian thì mở lại trọn vẹn.
- Mặc định gói sắp hết hạn dùng trước; khách tự kéo-thả đổi thứ tự.
- Mọi gói chạm hạn mức → API báo "mở lại sau X phút". Hết sạch credit → báo hết quota.

**5. Khu tài khoản (tiếng Việt)**
- Tổng quan: gói đang trả, credit còn, group và model được dùng.
- Gói của tôi: hàng đợi, mua thêm, đơn hàng, lịch sử gói.
- Sổ cái: từng request trừ bao nhiêu, từ gói nào, model nào.
- Mã quà tặng, API key (tạo key, secret chỉ hiện một lần, xoá), lịch sử dùng.

## Phía admin

- **Gói:** giá VND, giá USD, credit, thời hạn, hạn mức; group nào được mua, số lần mua mỗi tháng, ẩn/hiện, chưa mở bán, nổi bật. Thống kê: số gói đang chạy, người dùng, doanh thu VND/USD, credit đã tiêu. Sửa gói chỉ áp cho lần mua sau, trừ khi tick "áp dụng cho các gói đang chạy".
- **Group:** model được dùng, RPM/TPM, group mặc định. Không xoá được group còn người dùng.
- **Người dùng:** tìm, lọc, xem chi tiết (gói, đơn hàng, sổ cái, usage, key, phiên đăng nhập, mã quà tặng, nhật ký). Thao tác: tặng gói/credit, gia hạn, cộng/trừ credit, sửa hạn mức, thu hồi gói, đổi thứ tự, khoá key, khoá tài khoản (chặn API ngay), đổi group, đặt lại mật khẩu, xoá. Mọi thao tác phải ghi lý do và vào nhật ký.
- **Mã quà tặng:** tặng gói hoặc credit; giới hạn tổng lượt, lượt mỗi người, thời gian hiệu lực.
- **Thanh toán:** cấu hình nguồn nhận tiền (SePay, web2m, ACB, Binance), "Chạy thử" không ghi DB, danh sách giao dịch. Giao dịch sai tiền, chuyển muộn hoặc thiếu mã vào "Cần kiểm tra" để admin gán vào đơn hoặc đánh dấu đã xử lý. Báo qua Telegram.
- **Nội dung:** nội dung landing, banner thông báo, trang hướng dẫn `/docs`.

## Không làm (ở thời điểm này)

Ví nạp tiền / số dư, thẻ cào, tự gia hạn gói, hạn mức riêng từng model, giá riêng theo group, tài khoản team, affiliate, hoá đơn VAT, nhiều admin có phân quyền.
