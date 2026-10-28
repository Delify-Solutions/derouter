import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocBySlug, listPublishedDocs } from "@/lib/db/repos/contentRepo.js";
import { renderMarkdown } from "@/shared/utils/markdown.js";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const doc = await getDocBySlug(slug);
  // A draft resolves to null, so it also gets the not-found title rather than
  // leaking its existence through metadata.
  if (!doc) return { title: "Không tìm thấy trang - derouter" };
  return {
    title: `${doc.title} - derouter`,
    description: doc.summary || undefined,
  };
}

// One docs page. The body is Markdown written in the admin area, rendered through
// shared/utils/markdown.js which sanitises — marked alone passes raw HTML through,
// and this content is publicly served.
export default async function DocsPage({ params }) {
  const { slug } = await params;
  const doc = await getDocBySlug(slug);
  if (!doc) notFound();

  const html = renderMarkdown(doc.body);
  const all = await listPublishedDocs();

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <header className="border-b border-border">
        <div className="shell flex items-center justify-between py-4">
          <Link href="/" className="font-mono text-sm font-semibold uppercase tracking-[0.12em]">
            derouter
          </Link>
          <Link
            href="/docs"
            className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-main transition-colors hover:bg-surface-2"
          >
            Tất cả tài liệu
          </Link>
        </div>
      </header>

      <main className="shell grid grid-cols-1 gap-10 py-12 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Danh mục tài liệu" className="lg:sticky lg:top-6 lg:self-start">
          <p className="meta text-text-subtle">Tài liệu</p>
          <ul className="mt-3 flex flex-col gap-1">
            {all.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/docs/${entry.slug}`}
                  className={`block px-2 py-1.5 text-sm transition-colors hover:bg-surface-2 ${
                    entry.slug === doc.slug ? "text-brand-700 dark:text-brand-400" : "text-text-muted"
                  }`}
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{doc.title}</h1>
          {doc.summary ? <p className="mt-3 text-text-muted">{doc.summary}</p> : null}
          <div
            className="docs-body mt-8 text-text-main"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {doc.updatedAt ? (
            <p className="mt-10 border-t border-border pt-4 font-mono text-[11px] text-text-subtle">
              Cập nhật {new Date(doc.updatedAt).toLocaleDateString("vi-VN")}
            </p>
          ) : null}
        </article>
      </main>
    </div>
  );
}
