import { Card } from "@/shared/components";

// Escape hatch dashboardGuard.js redirects a signed-in account to when its
// permission matrix grants `view` on no page at all (spec admin-accounts
// "Permission enforcement on every admin surface"). Never itself gated.
export default function NoAccessPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="max-w-md text-center">
        <span className="material-symbols-outlined text-[32px] text-text-muted">lock</span>
        <h1 className="mt-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-main">
          Chưa được cấp quyền
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          Tài khoản của bạn chưa được cấp quyền xem trang nào. Liên hệ Super Admin để được cấp quyền.
        </p>
      </Card>
    </div>
  );
}
