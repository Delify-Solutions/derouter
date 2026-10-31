---
slug: omp
title: OMP (Oh My Pi)
section: Kết nối công cụ
excerpt: Thêm router vào models.yml của OMP, coding agent chạy trong terminal.
summary: OMP là bản mở rộng của coding agent Pi. Cấu hình provider tùy chỉnh bằng CC Switch hoặc bằng ~/.omp/agent/models.yml.
sortOrder: 150
---

OMP (oh-my-pi) là một coding agent chạy trong terminal, phát triển từ coding agent Pi của Mario Zechner. Lệnh chạy là `omp`. Mã nguồn chính thức: github.com/can1357/oh-my-pi.

> **Đã kiểm tra** với OMP 18.14.0 (gói `@oh-my-pi/pi-coding-agent`) và tài liệu `docs/models.md`, `docs/providers.md` trong repo chính thức, ngày 31/10/2026. Một số chi tiết chưa kiểm chứng được và được ghi chú ngay bên dưới.

Nếu chưa cài, dùng một trong các lệnh:

```bash
curl -fsSL https://omp.sh/install | sh
brew install can1357/tap/omp
bun install -g @oh-my-pi/pi-coding-agent
```

Trên Windows: `irm https://omp.sh/install.ps1 | iex`.

Bạn cần API key (xem [Bắt đầu nhanh](/docs/quickstart)) và tên một model trong `/v1/models`. `MODEL-ID` bên dưới là tên đó.

:::tabs
::tab[CC Switch]
CC Switch liệt kê Oh My Pi là một ứng dụng được hỗ trợ, ở chế độ cùng tồn tại. Cài CC Switch theo [hướng dẫn](/docs/cc-switch) trước.

1. Trong thanh bên trái, chọn **Oh My Pi**.
2. Nhấn **+** (Add Provider), chọn **Custom Configuration**.
3. Điền endpoint là `https://YOUR-DOMAIN/v1`, API key là key `sk-...` của bạn và model là `MODEL-ID`.

![Form thêm provider tùy chỉnh cho Oh My Pi trong CC Switch, đã điền endpoint, API key và model](/docs-img/omp/ccswitch-01-provider-form.png)

4. Nhấn **Add**, rồi nhấn **Enable** trên thẻ provider.
5. Mở terminal mới, chạy `omp`, gõ `/model` và chọn model vừa thêm.

![OMP đang chạy, menu /model có model từ provider vừa thêm và một phản hồi thành công](/docs-img/omp/ccswitch-02-running.png)

Chưa kiểm chứng: tài liệu của CC Switch không có mục riêng cho Oh My Pi (chỉ README và ghi chú phát hành nhắc tới), nên không rõ chính xác tệp nào được ghi và tên các ô trong form. Nếu sau khi bật mà `omp` không thấy provider, dùng tab Thủ công.

::tab[Thủ công]
OMP đọc provider tùy chỉnh từ `~/.omp/agent/models.yml` (định dạng YAML, không phải JSON). Tạo tệp này nếu chưa có.

```yaml
providers:
  derouter:
    baseUrl: https://YOUR-DOMAIN/v1
    apiKey: DEROUTER_API_KEY
    api: openai-completions
    models:
      - id: MODEL-ID
        name: Tên hiển thị của model
```

![Tệp ~/.omp/agent/models.yml mở trong trình soạn thảo với provider derouter](/docs-img/omp/manual-01-config.png)

Trường `apiKey` nhận tên một biến môi trường hoặc chính chuỗi key. Nếu giá trị trùng tên một biến môi trường đang có, OMP dùng giá trị của biến đó. Vì vậy cách an toàn là để tên biến trong tệp và export key ra shell:

```bash
export DEROUTER_API_KEY=sk-YOUR-KEY
```

Chạy với model vừa khai báo. Định dạng là `<id provider>/<id model>`:

```bash
omp --model derouter/MODEL-ID
```

Hoặc chạy `omp`, gõ `/model` và chọn từ danh sách. Lệnh `omp models` liệt kê các model đang có.

![OMP đang chạy với model derouter/MODEL-ID, trả lời một yêu cầu](/docs-img/omp/manual-02-running.png)

Các giá trị của `api` mà tài liệu OMP liệt kê cho provider tùy chỉnh:

| `api` | Endpoint mà router cung cấp |
| --- | --- |
| `openai-completions` | `/v1/chat/completions` |
| `openai-responses` | `/v1/responses` |
| `anthropic-messages` | `/v1/messages` |

Ghi chú:

- Mỗi model chỉ bắt buộc có `id`. Bạn có thể khai báo thêm `contextWindow` và `maxTokens` theo thông số model của mình; ví dụ chính thức có cả hai.
- Khi dùng `api: anthropic-messages`, chưa rõ OMP có tự thêm `/v1/messages` vào `baseUrl` hay không (ví dụ chính thức dùng `baseUrl` không có `/v1`). Nếu muốn dùng giao thức Claude, hãy thử trước và kiểm tra lại. Cách ổn định nhất là dùng `openai-completions` như trên.
- Chưa kiểm chứng: lệnh `omp login` có luồng nhập key cho provider tùy chỉnh hay không. Tài liệu chỉ mô tả `apiKey` trong `models.yml` và biến môi trường cho provider tùy chỉnh.
- Nếu `apiKey` được đặt cùng `authHeader: true` mà biến môi trường chưa tồn tại, header có thể thành `Bearer DEROUTER_API_KEY`. Hãy chắc rằng biến đã được export.
:::

## Khi gặp lỗi

- `omp` báo thiếu thông tin đăng nhập: chạy `/login` hoặc kiểm tra biến môi trường ở `apiKey` đã được export trong cùng terminal.
- Lỗi 404: `baseUrl` thiếu `/v1`, hoặc tên model không có trong `/v1/models`.
- Lỗi 401, 402, 403, 429 từ router: xem [Bắt đầu nhanh](/docs/quickstart).
