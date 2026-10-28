import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocBySlug, listDocsBySection } from "@/lib/db/repos/contentRepo.js";
import { renderMarkdown } from "@/shared/utils/markdown.js";
import DocsNav from "../components/DocsNav";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const doc = await getDocBySlug(slug);
  // A draft resolves to null, so it also gets the not-found title rather than
  // leaking its existence through metadata.
  if (!doc) return { title: "Không tìm thấy trang - derouter" };
  return {
    title: `${doc.title} - derouter`,
    description: doc.summary || doc.excerpt || undefined,
  };
}

// One docs page. Layout follows opencode.ai/v2/docs: section rail on top, pages
// of the active section down the left, article on the right.
//
// The body is Markdown written in the admin area, rendered through
// shared/utils/markdown.js which sanitises — marked alone passes raw HTML
// through, and this content is publicly served.
export default async function DocsPage({ params }) {
  const { slug } = await params;
  const doc = await getDocBySlug(slug);
  if (!doc) notFound();

  const html = renderMarkdown(doc.body);
  const groups = await listDocsBySection();

  // The sidebar shows the section this page belongs to, so a reader stays in
  // context instead of jumping between unrelated groups.
  const sectionKey = doc.section || "Khác";
  const activeGroup = groups.find((g) => g.section === sectionKey) ?? null;
  const pages = activeGroup?.pages ?? [];

  const currentIndex = pages.findIndex((p) => p.slug === doc.slug);
  const prev = currentIndex > 0 ? pages[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <DocsNav groups={groups} activeSlug={doc.slug} />

      <main className="shell grid grid-cols-1 gap-10 py-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        {pages.length > 0 ? (
          <nav aria-label="Trang trong nhóm" className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
            <p className="meta text-text-subtle">{activeGroup?.section}</p>
            <ul className="mt-3 flex flex-col gap-0.5 border-l border-border">
              {pages.map((entry) => {
                const isCurrent = entry.slug === doc.slug;
                return (
                  <li key={entry.id}>
                    <Link
                      href={`/docs/${entry.slug}`}
                      aria-current={isCurrent ? "page" : undefined}
                      className={`block border-l-2 py-1.5 pl-3 text-sm transition-colors ${
                        isCurrent
                          ? "border-brand-500 text-text-main"
                          : "-ml-px border-transparent text-text-muted hover:text-text-main"
                      }`}
                    >
                      {entry.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}

        <article className="min-w-0">
          {doc.section ? (
            <p className="meta text-text-subtle">{doc.section}</p>
          ) : null}
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{doc.title}</h1>
          {doc.summary ? <p className="mt-3 text-text-muted">{doc.summary}</p> : null}

          <div
            className="docs-body mt-8 text-text-main"
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {(prev || next) && (
            <nav aria-label="Trang trước và sau" className="mt-12 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
              {prev ? (
                <Link href={`/docs/${prev.slug}`} className="bg-surface p-4 transition-colors hover:bg-surface-2">
                  <span className="meta text-text-subtle">Trước</span>
                  <span className="mt-1 block text-sm text-text-main">{prev.title}</span>
                </Link>
              ) : <span className="hidden sm:block" />}
              {next ? (
                <Link href={`/docs/${next.slug}`} className="bg-surface p-4 text-right transition-colors hover:bg-surface-2">
                  <span className="meta text-text-subtle">Sau</span>
                  <span className="mt-1 block text-sm text-text-main">{next.title}</span>
                </Link>
              ) : null}
            </nav>
          )}

          {doc.updatedAt ? (
            <p className="mt-8 border-t border-border pt-4 font-mono text-[11px] text-text-subtle">
              Cập nhật {new Date(doc.updatedAt).toLocaleDateString("vi-VN")}
            </p>
          ) : null}
        </article>
      </main>
    </div>
  );
}
