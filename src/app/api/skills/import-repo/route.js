import { NextResponse } from "next/server";
import {
  parseRepoUrl,
  fetchTree,
  fetchFile,
  pickSkillPaths,
  describeSkillFile,
  MAX_REPO_FILES,
} from "@/lib/skills/repoImport.js";
import { MAX_IMPORT_ITEMS } from "@/lib/db/repos/skillsRepo.js";

export const dynamic = "force-dynamic";
// The tree walk plus one request per skill: a 40-skill repository takes a few
// seconds, and the platform default would cut it off mid-import.
export const maxDuration = 60;

/**
 * POST /api/skills/import-repo — read a skill library out of a git repository.
 *
 * Body: { url: string, path?: string, limit?: number }
 * Answers { repo, ref, path, skills: [...], ignored, truncated } where each skill
 * carries everything the import modal needs (name, slug, summary, body, bytes) and
 * the reason it cannot be imported, if any, in `problem`.
 *
 * Nothing is written here: this is the preview. The admin checks rows and posts the
 * chosen ones to /api/skills/bulk, so a wrong URL can never publish anything.
 */
export async function POST(request) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* answered below */
  }
  if (!body || typeof body !== "object" || typeof body.url !== "string") {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }

  const parsed = parseRepoUrl(body.url);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // A /tree/ URL carries its own scope; an explicit `path` overrides it so the
  // admin can paste a repo link and still point at one folder.
  const scope = typeof body.path === "string" && body.path.trim()
    ? body.path.trim()
    : parsed.path;

  let tree;
  try {
    tree = await fetchTree(parsed);
  } catch (error) {
    const status = error?.status;
    if (status === 404) {
      return NextResponse.json(
        { error: "Không tìm thấy repo — kiểm tra lại link, hoặc repo đang để private" },
        { status: 404 },
      );
    }
    if (status === 403 || status === 429) {
      return NextResponse.json(
        { error: "Máy chủ git đang giới hạn truy cập ẩn danh (GitHub: 60 lượt/giờ). Đợi vài phút rồi thử lại." },
        { status: 429 },
      );
    }
    if (error?.name === "TimeoutError") {
      return NextResponse.json({ error: "Repo phản hồi quá chậm, thử lại sau" }, { status: 504 });
    }
    return NextResponse.json(
      { error: "Không đọc được repo. Kiểm tra link và kết nối mạng của máy chủ." },
      { status: 502 },
    );
  }

  const { picked, ignored, scoped } = pickSkillPaths(tree.files, scope);
  const limit = Math.min(
    Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Math.trunc(Number(body.limit)) : MAX_REPO_FILES,
    MAX_IMPORT_ITEMS,
  );
  const wanted = picked.slice(0, limit);

  // Read the files in parallel but bounded: an anonymous GitHub raw read is fast,
  // and 100 at once would be a burst the host may throttle.
  const settled = await readAll(wanted, 8);

  const skills = [];
  let failed = 0;
  for (let i = 0; i < wanted.length; i += 1) {
    const outcome = settled[i];
    const read = outcome.status === "fulfilled";
    if (!read || outcome.value === null) failed += 1;
    skills.push(describeSkillFile(wanted[i].path, read ? outcome.value : null, { failed: !read }));
  }

  return NextResponse.json({
    repo: `${parsed.owner}/${parsed.repo}`,
    host: parsed.host,
    ref: tree.ref,
    path: scope,
    total: tree.files.length,
    matched: picked.length,
    imported: skills.length,
    ignored,
    scoped,
    failed,
    truncated: picked.length > wanted.length,
    incomplete: tree.incomplete === true,
    skills,
  }, { headers: { "Cache-Control": "no-store" } });
}

/** Run `read(url)` over items with at most `width` in flight, keeping order. */
async function readAll(files, width) {
  const out = new Array(files.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= files.length) return;
      out[index] = await fetchFile(files[index].url).then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", value: error }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, files.length) }, worker));
  return out;
}
