import Link from "next/link";
import { listDocsBySection } from "@/lib/db/repos/contentRepo.js";
import DocsNav from "./components/DocsNav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tài liệu - derouter",
  description: "Hướng dẫn sử dụng derouter: tạo API key, gọi model, theo dõi hạn mức.",
};

// Docs index, laid out like opencode.ai/v2/docs: sections across the top and a
// card per page. Server component — the list is read per request so a page an
// admin publishes appears without a redeploy.
export default async function DocsIndexPage() {
  const groups = await listDocsBySection();
  const total = groups.reduce((n, g) => n + g.pages.length, 0);

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <DocsNav groups={groups} />

      <main className="shell py-12">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Tài liệu</h1>
        <p className="mt-3 max-w-2xl text-text-muted">
          {total > 0
            ? `${total} trang hướng dẫn: tạo API key, gọi model và theo dõi hạn mức.`
            : "Hướng dẫn tạo API key, gọi model và theo dõi hạn mức."}
        </p>

        {groups.length === 0 ? (
          <p className="mt-10 border border-border bg-surface p-6 text-sm text-text-muted">
            Chưa có trang tài liệu nào được đăng.
          </p>
        ) : (
          <div className="mt-10 flex flex-col gap-10">
            {groups.map((group) => (
              <section key={group.section} aria-labelledby={`sec-${group.section}`}>
                <h2
                  id={`sec-${group.section}`}
                  className="meta text-text-subtle"
                >
                  {group.section}
                </h2>
                <ul className="mt-3 grid grid-cols-1 gap-px border border-border bg-border md:grid-cols-2">
                  {group.pages.map((page) => (
                    <li key={page.id} className="bg-surface">
                      <Link
                        href={`/docs/${page.slug}`}
                        className="block h-full p-5 transition-colors hover:bg-surface-2"
                      >
                        <h3 className="text-base font-semibold text-text-main">{page.title}</h3>
                        {page.excerpt ? (
                          <p className="mt-1.5 text-sm text-text-muted">{page.excerpt}</p>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
