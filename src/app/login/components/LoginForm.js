"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Input } from "@/shared/components";
import { ActionButton } from "@/app/account/components/ui";
import { safeNext } from "@/shared/utils/safeNext";
import AuthShell, { FormError, FormNotice, ResetPasswordForm } from "./AuthShell";

export default function LoginForm({ resetToken = "" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validated once, up front: the landing page sends `?next=/account/plans?plan=go`
  // so a customer lands back on the plan they picked. An invalid value is ignored
  // rather than forwarded (open-redirect guard, design D17).
  const nextTarget = safeNext(searchParams?.get?.("next")) ?? "/account";
  const [mode, setMode] = useState("signin"); // signin | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);

  if (resetToken) {
    return (
      <AuthShell
        eyebrow="Account"
        title="Choose a new password"
        intro="This link can be used once and expires one hour after it was sent."
        footer={
          <Link href="/login" className="hover:text-text-main transition-colors">
            Back to sign in
          </Link>
        }
      >
        <ResetPasswordForm token={resetToken} />
      </AuthShell>
    );
  }

  const signIn = async (event) => {
    event.preventDefault();
    const next = {};
    if (!email.trim()) next.email = "Enter your email address";
    if (!password) next.password = "Enter your password";
    setFieldErrors(next);
    setError("");
    setNotice("");
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const res = await fetch("/api/public/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not sign in");
        return;
      }
      router.replace(nextTarget);
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  const requestReset = async (event) => {
    event.preventDefault();
    if (!email.trim()) {
      setFieldErrors({ email: "Enter the email address on the account" });
      return;
    }
    setFieldErrors({});
    setError("");
    setPending(true);
    try {
      const res = await fetch("/api/public/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setNotice(data.message || "If that address has an account, a reset link is on its way");
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  const resendVerification = async () => {
    if (!email.trim()) {
      setFieldErrors({ email: "Enter your email address first" });
      return;
    }
    setResendPending(true);
    try {
      await fetch("/api/public/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setNotice("If the address needs verification, a new link is on its way");
      setError("");
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setResendPending(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Account"
      title={mode === "signin" ? "Sign in" : "Reset your password"}
      intro={
        mode === "signin"
          ? "Use the email address and password you registered with."
          : "We will mail a single-use link to that address."
      }
      footer={
        mode === "signin" ? (
          <div className="flex flex-col gap-2">
            <span>
              No account yet?{" "}
              <Link href="/register" className="font-medium text-text-main underline underline-offset-4">
                Create one
              </Link>
            </span>
            <button
              type="button"
              onClick={() => {
                setMode("forgot");
                setError("");
                setNotice("");
              }}
              className="text-sm text-text-muted hover:text-text-main transition-colors self-start"
            >
              Forgot password
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setMode("signin");
              setError("");
              setNotice("");
            }}
            className="text-sm text-text-muted hover:text-text-main transition-colors"
          >
            Back to sign in
          </button>
        )
      }
    >
      <form onSubmit={mode === "signin" ? signIn : requestReset} className="flex flex-col gap-4">
        <FormError message={error} />
        <FormNotice message={notice} />
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
        {mode === "signin" && (
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            autoComplete="current-password"
            required
          />
        )}
        <ActionButton type="submit" tone="solid" loading={pending} fullWidth>
          {mode === "signin" ? "Sign in" : "Send reset link"}
        </ActionButton>
        {mode === "signin" && (
          <ActionButton
            type="button"
            tone="ghost"
            size="sm"
            loading={resendPending}
            onClick={resendVerification}
            fullWidth
          >
            Resend verification email
          </ActionButton>
        )}
      </form>
    </AuthShell>
  );
}
