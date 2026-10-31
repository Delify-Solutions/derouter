---
slug: models
title: Model và combo
section: Tham khảo
excerpt: Liệt kê model của tài khoản, combo là gì, tham số thinking và reasoning, ảnh và embeddings.
summary: Cách xem model bạn gọi được, cách chọn mức suy luận, và các endpoint phụ như ảnh và embeddings.
sortOrder: 210
---

## Xem model của tài khoản

Danh sách model phụ thuộc vào nhóm của tài khoản. Cách chắc chắn nhất là hỏi chính API:

```bash
curl https://YOUR-DOMAIN/v1/models -H "Authorization: Bearer sk-YOUR-KEY"
```

Phản hồi theo dạng OpenAI: `{ "object": "list", "data": [ { "id": "...", ... } ] }`. Giá trị `id` là chuỗi bạn điền vào trường `model`. Danh sách này chỉ gồm model nhóm của bạn được phép gọi, và gói bạn mua không thu hẹp danh sách. Trang Tổng quan trong tài khoản cũng liệt kê các model này.

Gọi một model không có trong danh sách sẽ nhận lỗi 403 `model_not_allowed`. Gọi sai tên model có thể nhận lỗi 400 hoặc 404, xem [Xử lý sự cố](/docs/troubleshooting).

## Combo là gì

Tên model bạn gửi lên là tên một combo do quản trị viên cấu hình. Phía sau tên đó có một hoặc nhiều model thật. Router chọn model thật để gọi, và khi model đầu bị từ chối vì lý do thuộc về request (ví dụ vượt giới hạn ngữ cảnh), combo có thể chuyển sang model kế tiếp trong danh sách của nó.

Với bạn, combo chỉ là một tên model. Hai điểm cần nhớ:

- Giá token của combo là giá do quản trị viên đặt cho combo đó. Nếu không đặt, giá là của model đầu tiên trong combo. Bảng giá trên trang chủ hiển thị đúng giá này, và credit bị trừ theo giá đó.
- Tên combo có thể khác tên model gốc. Luôn dùng tên trong `/v1/models`.

## Endpoint

| Endpoint | Giao thức | Dùng cho |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | Chat, streaming, tool calling |
| `POST /v1/responses` | OpenAI Responses | Codex CLI và client dùng Responses API |
| `POST /v1/messages` | Claude | Claude Code, Anthropic SDK |
| `POST /v1/messages/count_tokens` | Claude | Đếm token trước khi gửi |
| `POST /v1/embeddings` | OpenAI | Vector hóa văn bản |
| `POST /v1/images/generations` | OpenAI | Tạo ảnh |
| `GET /v1/models` | OpenAI | Liệt kê model |

Router tự chuyển đổi định dạng, nên cùng một model gọi được qua nhiều endpoint chat. Embeddings và tạo ảnh chỉ dùng được với model thuộc loại đó trong tài khoản của bạn.

## Thinking và reasoning

Nhiều model có chế độ suy luận trước khi trả lời. Bạn điều khiển nó bằng tham số của giao thức bạn đang dùng, và router đổi sang dạng gốc của model phía sau:

| Cách | Ví dụ |
| --- | --- |
| OpenAI `reasoning_effort` | `"reasoning_effort": "high"` |
| Claude `thinking` | `"thinking": {"type": "enabled", "budget_tokens": 8192}` |
| Claude `output_config.effort` | `"output_config": {"effort": "medium"}` |
| Hậu tố trong tên model | `MODEL-ID(high)`, `MODEL-ID(8192)`, `MODEL-ID(none)` |

Router hiểu các mức `none`, `minimal`, `low`, `medium`, `high`, `xhigh` và `max`, cùng `auto` (để model tự quyết) và một con số cụ thể cho ngân sách token suy luận. Hậu tố `(none)` hoặc `(off)` tắt suy luận.

Ví dụ:

```bash
curl https://YOUR-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","reasoning_effort":"high","messages":[{"role":"user","content":"Giải thích độ phức tạp của quicksort"}]}'
```

Lưu ý:

- Mức suy luận mà model thật sự hỗ trợ khác nhau tùy model, và cách model xử lý mức không hỗ trợ cũng khác nhau. Hãy thử trên model của bạn.
- Token suy luận thường được tính là token output, nên mức cao có thể tốn credit hơn.
- Hậu tố dạng `(high)` tiện cho công cụ không cho thêm tham số tùy ý, vì bạn chỉ cần đổi tên model.

## Ảnh

Gửi ảnh vào model (vision): dùng phần `image_url` trong nội dung tin nhắn, với URL `https://` hoặc dữ liệu `data:` base64. Chỉ model hỗ trợ ảnh đầu vào mới xử lý được.

```bash
curl https://YOUR-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","messages":[{"role":"user","content":[{"type":"text","text":"Ảnh này có gì?"},{"type":"image_url","image_url":{"url":"https://example.com/anh.png"}}]}]}'
```

Tạo ảnh: gọi `POST /v1/images/generations` theo định dạng OpenAI với một model tạo ảnh có trong `/v1/models`.

```bash
curl https://YOUR-DOMAIN/v1/images/generations \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"IMAGE-MODEL-ID","prompt":"Một con mèo đội mũ phi hành gia"}'
```

Ảnh đầu vào dạng base64 làm request lớn. Nếu bị từ chối vì kích thước, giảm độ phân giải hoặc dùng URL.

## Embeddings

```bash
curl https://YOUR-DOMAIN/v1/embeddings \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"EMBEDDING-MODEL-ID","input":"văn bản cần vector hóa"}'
```
