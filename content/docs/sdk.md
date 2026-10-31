---
slug: sdk
title: SDK và curl
section: Kết nối công cụ
excerpt: Gọi API bằng OpenAI SDK, Anthropic SDK và curl, kể cả streaming.
summary: Ví dụ chạy được cho Python, Node.js và curl, theo cả giao thức OpenAI lẫn Claude.
sortOrder: 160
---

> **Đã kiểm tra** với OpenAI Python SDK 3.41.0 và Anthropic Python SDK 2.3.0 (tài liệu tại platform.claude.com và mô tả gói trên PyPI), ngày 31/10/2026. Các ví dụ Node.js chưa được đối chiếu với tài liệu của phiên bản hiện tại (openai 7.45.1 trên npm).

Mọi SDK hoạt động chỉ cần đổi hai thứ: base URL và API key. Trong các ví dụ, hãy thay `YOUR-DOMAIN` bằng địa chỉ của trang này (xem [Bắt đầu nhanh](/docs/quickstart)), `sk-YOUR-KEY` bằng key của bạn và `MODEL-ID` bằng một tên trong `/v1/models`.

Hai giao thức dùng hai base URL khác nhau:

| Giao thức | SDK | Base URL | Endpoint |
| --- | --- | --- | --- |
| OpenAI | OpenAI SDK | `https://YOUR-DOMAIN/v1` | `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings` |
| Claude | Anthropic SDK | `https://YOUR-DOMAIN` | `/v1/messages` |

Router tự chuyển đổi định dạng, nên cùng một model gọi được qua cả hai giao thức.

## Python với OpenAI SDK

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR-DOMAIN/v1",
    api_key="sk-YOUR-KEY",
)

response = client.chat.completions.create(
    model="MODEL-ID",
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(response.choices[0].message.content)
```

![Terminal chạy script Python dùng OpenAI SDK, in ra câu trả lời của model](/docs-img/sdk/01-python-sdk.png)

## Streaming

Thêm `stream=True` và đọc từng chunk:

```python
stream = client.chat.completions.create(
    model="MODEL-ID",
    messages=[{"role": "user", "content": "Đếm từ 1 đến 5"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

![Terminal in câu trả lời từng phần khi chạy script streaming](/docs-img/sdk/02-streaming.png)

Với curl, thêm `"stream": true` và cờ `-N` để curl không giữ đệm đầu ra:

```bash
curl -N https://YOUR-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","stream":true,"messages":[{"role":"user","content":"Đếm từ 1 đến 5"}]}'
```

Phản hồi là các dòng `data: {...}` (Server-Sent Events) và kết thúc bằng `data: [DONE]`.

## Node.js với OpenAI SDK

```bash
npm install openai
```

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://YOUR-DOMAIN/v1",
  apiKey: process.env.DEROUTER_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "MODEL-ID",
  messages: [{ role: "user", content: "Xin chào" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Python với Anthropic SDK

```bash
pip install anthropic
```

Anthropic SDK tự thêm `/v1/messages` vào base URL, nên dùng địa chỉ không có `/v1`. Bạn cũng có thể đặt biến môi trường `ANTHROPIC_BASE_URL` thay cho tham số `base_url`. SDK gửi key trong header `x-api-key`, router nhận header này.

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://YOUR-DOMAIN",
    api_key="sk-YOUR-KEY",
)

message = client.messages.create(
    model="MODEL-ID",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(message.content[0].text)
```

Streaming với Anthropic SDK:

```python
with client.messages.stream(
    model="MODEL-ID",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Đếm từ 1 đến 5"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
print()
```

## curl theo giao thức Claude

```bash
curl https://YOUR-DOMAIN/v1/messages \
  -H "x-api-key: sk-YOUR-KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL-ID","max_tokens":256,"messages":[{"role":"user","content":"Xin chào"}]}'
```

## Embeddings

```bash
curl https://YOUR-DOMAIN/v1/embeddings \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"EMBEDDING-MODEL-ID","input":"văn bản cần mã hóa"}'
```

Model embedding chỉ dùng được nếu tài khoản của bạn có model loại này. Xem [Model và combo](/docs/models) để biết cách kiểm tra.

## Lưu ý

- Đặt key trong biến môi trường, không ghi thẳng vào mã nguồn.
- Lỗi từ router có dạng JSON `{ "error": { "message", "type", "code" } }`, giống định dạng lỗi của OpenAI. SDK sẽ ném exception với `status_code` tương ứng. Ý nghĩa từng mã: xem [Bắt đầu nhanh](/docs/quickstart).
- Cả hai SDK Python mặc định tự thử lại 2 lần khi gặp lỗi kết nối, 429 và 5xx. Nếu muốn tự xử lý `Retry-After`, đặt `max_retries=0` khi tạo client.
- Anthropic SDK 2.x tự gửi header `anthropic-version` theo phiên bản API của nó. Router không kiểm tra giá trị header này từ client, nên bạn không cần đặt thủ công.
