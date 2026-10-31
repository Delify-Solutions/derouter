"use client";

import { Page } from "@/app/account/components/ui";
import ModelPlayground from "@/shared/components/ModelPlayground";

function errorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (typeof data.error?.message === "string") return data.error.message;
  return fallback;
}

const post = (body, signal) =>
  fetch("/api/account/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

// Every call goes through /api/account/chat, which uses the customer's own key on
// the public /v1 handlers, so the model list, limits and credit charge are the same
// as for an API request. Module-level so the playground sees a stable transport.
const TRANSPORT = {
  async loadModels() {
    const res = await fetch("/api/account/chat/models", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(data, "Không tải được danh sách model"));
    return data;
  },
  chat: ({ model, messages, signal }) => post({ type: "chat", model, messages, stream: true }, signal),
  image: ({ body, signal }) => post({ type: "image", ...body }, signal),
};

/**
 * Web chat for a signed-in customer: text chat with streaming and image generation.
 * The screen itself is the shared ModelPlayground (also used on the public /usage
 * page); this wrapper only supplies the page frame and the session-based transport.
 * Conversations live in memory only: closing the tab clears them, nothing is stored
 * on the server.
 */
export default function ChatClient() {
  return (
    <Page
      title="Chat"
      description="Chat với model hoặc tạo ảnh ngay tại đây. Mỗi lượt gọi dùng key riêng của bạn và trừ vào credit như một request API; nội dung không được lưu trên máy chủ."
    >
      <ModelPlayground transport={TRANSPORT} storageKey="account.chat.mode" />
    </Page>
  );
}
