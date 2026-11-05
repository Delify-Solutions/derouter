"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionButton, Panel, Section, Tag, buttonClass } from "@/app/account/components/ui";
import { TelegramLinkPrompt } from "@/app/account/components/TelegramLink";
import { grantText, redeemGift } from "./redeemApi";

function fmtDay(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * "Mã có thể sử dụng" (change channel-gift): the codes the admin listed that this
 * account can still take, each with a "Nhận" button and what it needs first (a
 * Telegram link, joining the channel). Hidden when there is none.
 *
 * `onRedeemed(data)` gets the redeem response (it may carry `channelOffer`).
 */
export default function AvailableGifts({ refreshKey = 0, onRedeemed }) {
  const [codes, setCodes] = useState([]);
  const [channelUrl, setChannelUrl] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/gifts/available", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setCodes(Array.isArray(data.codes) ? data.codes : []);
        setChannelUrl(typeof data.channelUrl === "string" ? data.channelUrl : "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  if (codes.length === 0) return null;
  return (
    <Section title="Mã có thể sử dụng" description="Mã đang mở cho tài khoản của bạn. Bấm Nhận để cộng ngay, không cần gõ mã.">
      <ul className="grid gap-3 md:grid-cols-2">
        {codes.map((gift) => (
          <li key={gift.id}>
            <GiftCard gift={gift} channelUrl={channelUrl} onRedeemed={onRedeemed} onLinked={refresh} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function GiftCard({ gift, channelUrl, onRedeemed, onLinked }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { text, channelUrl? }
  const expires = fmtDay(gift.expiresAt);
  const isChannel = gift.kind === "channel";

  const take = async () => {
    setBusy(true);
    setError(null);
    const result = await redeemGift(gift.code);
    setBusy(false);
    if (!result.ok) {
      setError({ text: result.error, channelUrl: result.channelUrl || (result.code === "channel_required" ? channelUrl : "") });
      return;
    }
    onRedeemed?.(result.data);
  };

  return (
    <Panel className="flex h-full flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-lg font-semibold text-text-main">{grantText(gift.grant)}</p>
          <p className="font-mono text-xs text-text-muted">
            Mã <span className="text-text-main">{gift.code}</span>
            {gift.grant?.durationDays ? ` · dùng trong ${gift.grant.durationDays} ngày` : ""}
          </p>
        </div>
        {isChannel ? <Tag icon="campaign">Tham gia kênh</Tag> : gift.kind === "new_user" ? <Tag icon="person_add">Người mới</Tag> : null}
      </div>

      {isChannel ? (
        <ol className="flex flex-col gap-1.5 text-sm text-text-muted">
          <li className="flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{gift.needsTelegram ? "radio_button_unchecked" : "check_circle"}</span>
            <span>
              Liên kết Telegram với tài khoản
              {gift.needsTelegram ? null : <span className="sr-only"> (đã xong)</span>}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">group_add</span>
            <span>
              Tham gia{" "}
              {channelUrl ? (
                <a href={channelUrl} target="_blank" rel="noopener noreferrer" className="text-text-main underline underline-offset-4">
                  kênh Telegram
                </a>
              ) : "kênh Telegram"}{" "}
              bằng chính tài khoản Telegram đó, rồi bấm Nhận. Mỗi Telegram nhận một lần.
            </span>
          </li>
        </ol>
      ) : null}

      {gift.needsTelegram ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-muted">Cần liên kết Telegram trước khi nhận mã này.</p>
          <TelegramLinkPrompt onLinked={onLinked} />
        </div>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-3">
          <ActionButton tone="solid" loading={busy} onClick={take}>Nhận</ActionButton>
          {isChannel && channelUrl ? (
            <a href={channelUrl} target="_blank" rel="noopener noreferrer" className={buttonClass({ tone: "outline" })}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
              Mở kênh
            </a>
          ) : null}
          {expires ? <span className="text-xs text-text-muted">Hạn nhận: {expires}</span> : null}
        </div>
      )}

      {error ? (
        <div role="alert" className="flex flex-col gap-2 border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          <span>{error.text}</span>
          {error.channelUrl ? (
            <span className="text-text-muted">
              Tham gia{" "}
              <a href={error.channelUrl} target="_blank" rel="noopener noreferrer" className="text-text-main underline underline-offset-4">kênh Telegram</a>
              {" "}xong thì bấm Nhận lại.
            </span>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
