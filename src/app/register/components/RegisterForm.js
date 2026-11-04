"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Input } from "@/shared/components";
import { ActionButton } from "@/app/account/components/ui";
import { safeNext } from "@/shared/utils/safeNext";
import AuthShell, { FormError, FormNotice } from "@/app/login/components/AuthShell";
import { giftPageHref, readPendingGiftCode } from "@/shared/utils/promoPopup.js";

/**
 * The referral banner (spec account-registration "Register page shows the referral
 * welcome gift"). It names the CODE, never the affiliate: the referrer's address is
 * not the visitor's business, and the code is what the gift page will ask for.
 */
function ReferralBanner({ referral }) {
  if (!referral?.code) return null;
  return (
    <div
      className="border border-brand-500/30 bg-brand-500/10 px-3 py-3 text-sm text-brand-700 dark:text-brand-400"
    >
      <p className="flex items-center gap-2 font-medium">
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">group_add</span>
        Bạn được giới thiệu
      </p>
      {referral.giftCode ? (
        <>
          <p className="mt-2 text-text-muted">
            Mã quà tặng chào mừng:{" "}
            <code className="font-mono font-medium text-text-main">{referral.giftCode}</code>
          </p>
          <p className="mt-1 text-text-muted">
            Mã này cần liên kết Telegram. Sau khi đăng ký, nhập mã ở trang “Mã quà tặng”.
          </p>
        </>
      ) : null}
    </div>
  );
}

export default function RegisterForm({ referral = null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Carried through signup → verification mail → verify-email page → login, so a
  // visitor who clicked "Chọn Go" on the landing page ends on that plan. Dropped
  // when invalid (open-redirect guard, design D17).
  const nextTarget = safeNext(searchParams?.get?.("next"));
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const next = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address";
    if (password.length < 10) next.password = "Use at least 10 characters";
    if (password !== confirm) next.confirm = "Passwords do not match";
    setFieldErrors(next);
    setError("");
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const res = await fetch("/api/public/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
          // The API validates it again; only the verification mail carries it.
          ...(nextTarget ? { next: nextTarget } : {}),
          // The code the banner displayed (spec: "The register form SHALL send the
          // code it displayed as ref"). An invalid one simply binds nobody.
          ...(referral?.code ? { ref: referral.code } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Registration is unavailable right now");
        return;
      }
      if (data.signedIn) {
        // No email verification on this instance: the session cookie is already
        // set, so land where a login would have (validated `next`, else /account).
        // A code picked up from the promo popup takes the new customer straight
        // to the gift page with it prefilled (spec promo-popup).
        const pending = nextTarget ? "" : readPendingGiftCode();
        router.replace(nextTarget ?? (pending ? giftPageHref(pending) : "/account"));
        router.refresh();
        return;
      }
      if (data.verificationSent === false) {
        // Active account but auto sign-in failed: no mail is coming, so send the
        // visitor to sign in instead of the inbox screen.
        router.replace(nextTarget ? `/login?next=${encodeURIComponent(nextTarget)}` : "/login");
        return;
      }
      setDone(data.message || "Check your email for the verification link");
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <AuthShell
        eyebrow="Account"
        title="Check your inbox"
        footer={
          <Link
            href={nextTarget ? `/login?next=${encodeURIComponent(nextTarget)}` : "/login"}
            className="font-medium text-text-main underline underline-offset-4"
          >
            Go to sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-4">
          <FormNotice message={done} />
          <p className="text-sm text-text-muted">
            The link is single-use and expires in 24 hours. If no message arrives, check that
            the address is spelled correctly, then request another link from the sign-in page.
          </p>
          <ActionButton
            onClick={() => {
              setDone("");
              router.refresh();
            }}
            fullWidth
          >
            Use a different address
          </ActionButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Account"
      title="Create an account"
      intro="One account holds your API keys, credit balance and plans."
      footer={
        <span>
          Already registered?{" "}
          <Link
            href={nextTarget ? `/login?next=${encodeURIComponent(nextTarget)}` : "/login"}
            className="font-medium text-text-main underline underline-offset-4"
          >
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ReferralBanner referral={referral} />
        <FormError message={error} />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          inputClassName="font-mono"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
        <Input
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          hint="Optional. Shown in your account only."
          autoComplete="nickname"
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint="At least 10 characters"
          autoComplete="new-password"
          required
        />
        <Input
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
          autoComplete="new-password"
          required
        />
        <ActionButton type="submit" tone="solid" loading={pending} fullWidth>
          Create account
        </ActionButton>
      </form>
    </AuthShell>
  );
}
