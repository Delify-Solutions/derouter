"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/shared/components";
import AuthShell, { FormError, FormNotice } from "@/app/login/components/AuthShell";

export default function RegisterForm() {
  const router = useRouter();
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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Registration is unavailable right now");
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
          <Link href="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
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
          <Button
            variant="secondary"
            onClick={() => {
              setDone("");
              router.refresh();
            }}
            fullWidth
          >
            Use a different address
          </Button>
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
          <Link href="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
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
        <Button type="submit" variant="primary" loading={pending} disabled={pending} fullWidth>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
