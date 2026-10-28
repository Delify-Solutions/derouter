import Link from "next/link";
import { listPublishedDocs } from "@/lib/db/repos/contentRepo.js";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tài liệu - derouter",
  description: "Hướng dẫn sử dụng derouter: tạo API key, gọi model, theo dõi hạn mức.",
};

// Docs index. Server component: the list is read per request so a page an admin
// publishes appears without a redeploy.
export default async function DocsIndexPage() {
  const docs = await listPublishedDocs();

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <header className="border-b border-border">
        <div className="shell flex items-center justify-between py-4">
          <Link href="/" className="font-mono text-sm font-semibold uppercase tracking-[0.12em]">
            derouter
          </Link>
          <Link
            href="/"
            className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-main transition-colors hover:bg-surface-2"
          >
            Trang chủ
          </Link>
        </div>
      </header>

      <main className="shell py-16">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Tài liệu</h1>
        <p className="mt-3 max-w-2xl text-text-muted">
          Hướng dẫn tạo API key, gọi model và theo dõi hạn mức.
        </p>

        {docs.length === 0 ? (
          <p className="mt-10 border border-border bg-surface p-6 text-sm text-text-muted">
            Chưa có trang tài liệu nào được đăng.
          </p>
        ) : (
          <ul className="mt-10 grid grid-cols-1 gap-px border border-border bg-border md:grid-cols-2">
            {docs.map((doc) => (
              <li key={doc.id} className="bg-surface">
                <Link href={`/docs/${doc.slug}`} className="block p-6 transition-colors hover:bg-surface-2">
                  <h2 className="text-base font-semibold text-text-main">{doc.title}</h2>
                  {doc.summary ? (
                    <p className="mt-2 text-sm text-text-muted">{doc.summary}</p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
