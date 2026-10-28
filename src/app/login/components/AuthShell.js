"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/shared/components";

// Square, hairline, mono-control styling per openspec/ui-dna.md. No gradient, no
// blur, no rounded corner; the only motion is a 150ms colour transition.
export default function AuthShell({ title, eyebrow, intro, children, footer }) {
  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <header className="h-16 border-b border-border flex items-center px-6">
        <Link href="/" className="meta text-text-main hover:text-brand-600 transition-colors">
          derouter
        </Link>
      </header>

      <main className="flex-1 flex items-start justify-center px-4 py-16">
        <div className="w-full max-w-[420px]">
          <p className="meta text-text-muted">{eyebrow}</p>
          <h1 className="text-2xl font-semibold text-text-main mt-2">{title}</h1>
          {intro && <p className="text-sm text-text-muted mt-2">{intro}</p>}
          <div className="border border-border bg-surface p-6 mt-6">{children}</div>
          {footer && <div className="mt-4 text-sm text-text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export function FormError({ message }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border border-red-600/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm px-3 py-2 flex items-start gap-2"
    >
      <span className="material-symbols-outlined text-[16px] mt-0.5">error</span>
      <span>{message}</span>
    </div>
  );
}

export function FormNotice({ message }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="border border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400 text-sm px-3 py-2 flex items-start gap-2"
    >
      <span className="material-symbols-outlined text-[16px] mt-0.5">check_circle</span>
      <span>{message}</span>
    </div>
  );
}

/**
 * Shared reset-password panel. Reused by /login (token from the emailed link) so
 * there is one implementation of the exchange.
 */
export function ResetPasswordForm({ token, onDone }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const next = {};
    if (password.length < 10) next.password = "Use at least 10 characters";
    if (password !== confirm) next.confirm = "Passwords do not match";
    setFieldErrors(next);
    setError("");
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const res = await fetch("/api/public/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not reset the password");
        return;
      }
      setDone(true);
      if (onDone) onDone();
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return <FormNotice message="Password updated. Sign in with the new password." />;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError message={error} />
      <Input
        label="New password"
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
      <Button type="submit" variant="primary" loading={pending} disabled={pending} fullWidth>
        Set new password
      </Button>
    </form>
  );
}
