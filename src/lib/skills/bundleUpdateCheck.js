// Whether a bundle's source repository has moved past what was last imported.
//
// A bundle has no git tag or release to read a real version number from (checked:
// rea_policy ships neither), so the only honest signal of "there is something new"
// is the commit SHA its source host resolves `sourceRef` to right now, compared
// against `importedSha` (the SHA it resolved to the last time this bundle's
// content was imported or synced). Three hosts, one call each, same shape as
// repoImport.js's own tree reads — this file only adds the "just the latest
// commit" half those don't need.
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 3600000; // 1h, same window as the npm self-update check (api/version)

// Survive hot reload; one cache per process, keyed by bundle id.
const cache = (global.__bundleShaCache ??= new Map());

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      // GitHub rejects anonymous API calls without a UA, same header repoImport.js sends.
      "user-agent": "derouter-skill-import",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * The latest commit SHA on `ref`, straight from the source host — no caching, no
 * fallback: callers that want resilience use `checkBundleUpdate` instead.
 *
 * @param {{host:string, owner:string, repo:string, ref?:string}} source
 */
export async function fetchLatestCommitSha({ host, owner, repo, ref }) {
  const effectiveRef = ref || "main";
  if (host === "gitlab.com") {
    const project = encodeURIComponent(`${owner}/${repo}`);
    const commit = await getJson(
      `https://gitlab.com/api/v4/projects/${project}/repository/commits/${encodeURIComponent(effectiveRef)}`,
    );
    return commit.id || null;
  }
  if (host && host !== "github.com" && host !== "www.github.com") {
    // Forgejo / Codeberg: Gitea-compatible API. A ref's "commits" list, newest
    // first, one item -- there is no single-commit-by-ref endpoint on this API.
    const commits = await getJson(
      `https://${host}/api/v1/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(effectiveRef)}&limit=1`,
    );
    return Array.isArray(commits) && commits[0] ? commits[0].sha : null;
  }
  const commit = await getJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(effectiveRef)}`,
  );
  return commit.sha || null;
}

/**
 * Whether `bundle` has a newer commit upstream than `bundle.importedSha` records.
 * Never throws: a host hiccup (rate limit, timeout) means "cannot tell right now",
 * answered with the last cached SHA (or none), not treated as "broken".
 *
 * `hasUpdate` is only ever true when `importedSha` is set — a bundle never synced
 * (or written before this column existed) has nothing to compare against, so it is
 * reported as up to date rather than flagged on the strength of a guess.
 *
 * @param {{id:string, sourceHost:string, sourceOwner:string, sourceRepo:string, sourceRef:string, importedSha:string|null}} bundle
 * @returns {Promise<{latestSha:string|null, hasUpdate:boolean}>}
 */
export async function checkBundleUpdate(bundle) {
  if (!bundle?.id || !bundle?.sourceOwner || !bundle?.sourceRepo) {
    return { latestSha: null, hasUpdate: false };
  }

  const cached = cache.get(bundle.id);
  const answer = (sha) => ({ latestSha: sha, hasUpdate: Boolean(bundle.importedSha && sha && sha !== bundle.importedSha) });

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return answer(cached.sha);
  }

  try {
    const sha = await fetchLatestCommitSha({
      host: bundle.sourceHost,
      owner: bundle.sourceOwner,
      repo: bundle.sourceRepo,
      ref: bundle.sourceRef,
    });
    if (sha) cache.set(bundle.id, { sha, fetchedAt: Date.now() });
    return answer(sha);
  } catch {
    return answer(cached?.sha ?? null);
  }
}
