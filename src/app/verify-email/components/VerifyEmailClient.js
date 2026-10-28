"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AuthShell, { FormError } from "@/app/login/components/AuthShell";

export default function VerifyEmailClient({ token = "" }) {
  const [state, setState] = useState(token ? "pending" : "missing");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/public/verify-email?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setState("ok");
          setMessage(data.email ? `${data.email} is verified.` : "Your address is verified.");
        } else {
          setState("failed");
          setMessage(data.error || "This link is invalid or has expired.");
        }
      } catch {
        if (!cancelled) {
          setState("failed");
          setMessage("Could not reach the server. Reload the page to try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const title =
    state === "ok" ? "Email verified" : state === "failed" ? "Link not accepted" : "Verifying your email";

  return (
    <AuthShell
      eyebrow="Account"
      title={title}
      footer={
        <div className="flex flex-col gap-2">
          <Link href="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
            Go to sign in
          </Link>
          <span className="text-xs">
            Need a new link? Open the sign-in page and use “Resend verification email”.
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {state === "pending" && (
          <div className="flex items-center gap-3 text-sm text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            Checking the link.
          </div>
        )}
        {state === "ok" && (
          <div
            role="status"
            className="border border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400 text-sm px-3 py-2 flex items-start gap-2"
          >
            <span className="material-symbols-outlined text-[16px] mt-0.5">check_circle</span>
            <span>{message} You can sign in now.</span>
          </div>
        )}
        {(state === "failed" || state === "missing") && (
          <>
            <FormError message={state === "missing" ? "This page needs a verification token." : message} />
            <p className="text-sm text-text-muted">
              Verification links are single-use and expire after 24 hours. A new one can be sent
              from the sign-in page.
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}
