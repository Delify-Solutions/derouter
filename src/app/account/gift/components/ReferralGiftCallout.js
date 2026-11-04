"use client";

import { useCallback, useEffect, useState } from "react";
import { Eyebrow, Panel } from "@/app/account/components/ui";
import { TelegramLinkPrompt, useTelegramLink } from "@/app/account/components/TelegramLink";

/**
 * "Quà giới thiệu" (design D7): the welcome gift the account was referred with.
 *
 * The code comes from the affiliate API (empty when there is no referrer, no
 * eligible code, or the account already took it). `onCode` hands it to the redeem
 * form, which prefills it. The redeem rules are untouched, so a new-user code
 * still needs a linked Telegram — the prompt only appears while it is missing.
 */
export default function ReferralGiftCallout({ onCode, refreshKey = 0 }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/affiliate/gift", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const value = typeof data?.code === "string" ? data.code : "";
        setCode(value);
        if (onCode) onCode(value);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `refreshKey` changes after a redemption: the API then answers with no code
    // (already redeemed) and the callout goes away instead of claiming the code is
    // still prefilled.
  }, [onCode, refreshKey]);

  if (loading || !code) return null;
  return <CalloutBody code={code} />;
}

function CalloutBody({ code }) {
  const { status, setStatus } = useTelegramLink();
  // The hook's own poll reports the new identity; mirroring it hides the prompt
  // without another request.
  const onLinked = useCallback((next) => { if (next) setStatus(next); }, [setStatus]);

  // The prompt is only useful to an account without a Telegram user. Before the
  // status resolves nothing is shown: a flash of "link Telegram" would be noise.
  const needsLink = Boolean(status && status.configured !== false && status.linked !== true);

  return (
    <Panel className="mb-6 p-5">
      <div className="flex flex-col gap-3">
        <Eyebrow>Quà giới thiệu</Eyebrow>
        <p className="text-sm text-text-main">
          Người giới thiệu bạn tặng mã{" "}
          <code className="font-mono font-medium">{code}</code>
        </p>
        <p className="text-sm text-text-muted">
          Mã người mới cần liên kết Telegram. Mã đã được điền sẵn trong ô bên dưới.
        </p>
        {needsLink ? <TelegramLinkPrompt onLinked={onLinked} /> : null}
      </div>
    </Panel>
  );
}
