---
slug: plans
title: Gói, credit và hạn mức
section: Tham khảo
excerpt: Credit trừ thế nào, hàng đợi gói, hạn mức theo khung giờ, rate limit và các trang xem mức dùng.
summary: Cơ chế đằng sau lỗi 402 và 429: mỗi gói là một khoản credit riêng, xếp hàng đợi, có hạn và có hạn mức.
sortOrder: 220
---

## Credit và giá token

Mỗi lần mua gói hoặc nhận quà tặng tạo ra một gói riêng. Gói có một khoản credit dùng chung cho mọi model trong nhóm của bạn, có hạn dùng (ví dụ 30 ngày) và có thể có hạn mức theo khung giờ. Không có hạn mức riêng cho từng model.

Mỗi request trừ credit theo giá token của model, tính cho 1 triệu token ở ba loại: input, output và cached input. Model đắt hoặc request dài thì dùng credit nhanh hơn.

Ví dụ: một model giá $A cho 1 triệu token input và $B cho 1 triệu token output. Request 20.000 token input và 2.000 token output tốn:

```text
20.000 / 1.000.000 x A  +  2.000 / 1.000.000 x B
```

Giá thật của từng model nằm trong bảng giá trên trang chủ. Credit được trừ sau khi request hoàn tất.

## Hàng đợi gói

Khi có nhiều gói, chúng xếp thành một hàng đợi. Mỗi request trừ vào gói đầu hàng đợi còn credit và chưa chạm hạn mức. Gói đó hết credit, hết hạn hoặc chạm hạn mức thì request chuyển sang gói kế tiếp.

- Mặc định, gói sắp hết hạn được dùng trước.
- Bạn đổi thứ tự trong mục Gói của tôi: kéo thả, hoặc dùng nút lên và xuống, rồi lưu thứ tự.
- Credit chưa dùng sẽ mất khi gói hết hạn. Phần bị mất được ghi trong Nhật ký credit.
- Mua thêm gói không làm mất credit còn lại của các gói cũ.

![Trang Gói của tôi với hàng đợi gói, mỗi gói có credit còn lại, hạn dùng và nút đổi thứ tự](/docs-img/plans/01-queue.png)

## Hạn mức theo khung giờ

Một gói có thể có một hoặc nhiều hạn mức, mỗi hạn mức là số tiền tối đa được dùng trong một khung thời gian, ví dụ "tối đa $20 mỗi 5 giờ" hoặc "tối đa $80 mỗi 1 tuần".

- Khung giờ bắt đầu từ lần đầu gói bị trừ credit.
- Hết khung giờ, hạn mức mở lại đầy đủ. Lần trừ credit kế tiếp bắt đầu khung mới.
- Hạn mức được kiểm tra trước khi nhận request, còn chi phí được tính sau khi request xong. Vì vậy một request cuối cùng có thể đẩy tổng chi tiêu vượt hạn mức một chút.
- Khi một gói chạm hạn mức, nó tạm khóa cho đến khi khung giờ kết thúc, và request chuyển sang gói kế tiếp nếu có.

## Rate limit

Gói còn có thể giới hạn số request mỗi phút (RPM) và số token mỗi phút (TPM). Quy tắc áp dụng:

- Giá trị lấy từ gói đang đứng đầu hàng đợi, đọc lại ở mỗi request. Gói không đặt giá trị nào thì không bị giới hạn.
- RPM đếm số request của mọi key thuộc cùng tài khoản trong 60 giây gần nhất. TPM đếm tổng token prompt và completion của mọi key trong 60 giây gần nhất. Nhiều key dùng chung một hạn mức, không nhân lên.
- Vượt RPM thì request bị từ chối ngay với lỗi 429 `rate_limit` và header `Retry-After: 60`.
- Vượt TPM thì request chờ có chỗ trống, tối đa 30 giây. Hết thời gian chờ mà vẫn vượt, request nhận lỗi 429 `rate_limit`.

## Khi nào gặp lỗi

| Tình huống | Phản hồi |
| --- | --- |
| Không còn gói nào có credit | 402 `insufficient_quota` |
| Mọi gói còn credit đều đang chạm hạn mức khung giờ | 429 `plan_limit`, kèm `Retry-After` (giây) và `resetAt` (giờ UTC) |
| Vượt RPM hoặc TPM của gói | 429 `rate_limit`, `Retry-After: 60` |

Với `plan_limit`, `Retry-After` và `resetAt` trỏ tới thời điểm sớm nhất mà một gói mở lại. Thông báo tiếng Việt trong `message` nêu thời gian chờ còn lại. Định dạng đầy đủ của các lỗi này nằm ở [Bắt đầu nhanh](/docs/quickstart).

## Xem mức dùng

| Nơi xem | Nội dung |
| --- | --- |
| Tổng quan | Gói đang trả, credit còn lại, nhóm và model được dùng |
| Gói của tôi | Hàng đợi, đơn hàng, lịch sử gói, mua thêm gói |
| Nhật ký credit | Từng khoản cộng và trừ credit, thuộc gói nào |
| Lịch sử dùng | Từng request: model, token, chi phí |
| Trang `/usage` | Dán một API key để xem mức dùng của key đó, không cần đăng nhập |

![Trang Nhật ký credit với các dòng trừ credit, mỗi dòng ghi gói và số tiền](/docs-img/plans/02-ledger.png)
