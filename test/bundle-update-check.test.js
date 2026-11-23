// bundleUpdateCheck.js: the one external-call half of bundle versioning — whether
// a bundle's source repo has moved past what was imported. No real network: a
// stubbed global fetch, same convention as test/deepai.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

const { fetchLatestCommitSha, checkBundleUpdate } = await import("../src/lib/skills/bundleUpdateCheck.js");

function withFetch(handler, run) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => { globalThis.fetch = real; });
}

let nextId = 0;
const bundle = (patch) => ({
  id: `bundle-${nextId++}`, // unique per call: the module caches per bundle id
  sourceHost: "github.com",
  sourceOwner: "Delify-Solutions",
  sourceRepo: "rea_policy",
  sourceRef: "main",
  importedSha: null,
  ...patch,
});

test("fetchLatestCommitSha reads GitHub's commits/{ref}.sha", async () => {
  let calledUrl = null;
  await withFetch(
    async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ sha: "a1b2c3d4" }), { status: 200 });
    },
    async () => {
      const sha = await fetchLatestCommitSha({ host: "github.com", owner: "o", repo: "r", ref: "main" });
      assert.equal(sha, "a1b2c3d4");
    },
  );
  assert.equal(calledUrl, "https://api.github.com/repos/o/r/commits/main");
});

test("fetchLatestCommitSha reads GitLab's repository/commits/{ref}.id, project id URL-encoded", async () => {
  let calledUrl = null;
  await withFetch(
    async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ id: "deadbeef" }), { status: 200 });
    },
    async () => {
      const sha = await fetchLatestCommitSha({ host: "gitlab.com", owner: "group/sub", repo: "r", ref: "main" });
      assert.equal(sha, "deadbeef");
    },
  );
  assert.equal(calledUrl, "https://gitlab.com/api/v4/projects/group%2Fsub%2Fr/repository/commits/main");
});

test("fetchLatestCommitSha reads a Gitea/Forgejo host's commits list, newest first", async () => {
  let calledUrl = null;
  await withFetch(
    async (url) => {
      calledUrl = String(url);
      return new Response(JSON.stringify([{ sha: "feedface" }, { sha: "older" }]), { status: 200 });
    },
    async () => {
      const sha = await fetchLatestCommitSha({ host: "codeberg.org", owner: "o", repo: "r", ref: "main" });
      assert.equal(sha, "feedface");
    },
  );
  assert.equal(calledUrl, "https://codeberg.org/api/v1/repos/o/r/commits?sha=main&limit=1");
});

test("fetchLatestCommitSha defaults ref to main when the bundle names none", async () => {
  let calledUrl = null;
  await withFetch(
    async (url) => { calledUrl = String(url); return new Response(JSON.stringify({ sha: "x" }), { status: 200 }); },
    async () => { await fetchLatestCommitSha({ host: "github.com", owner: "o", repo: "r" }); },
  );
  assert.match(calledUrl, /\/commits\/main$/);
});

test("checkBundleUpdate: no importedSha means never flagged, even with a real latest sha", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ sha: "fresh" }), { status: 200 }),
    async () => {
      const result = await checkBundleUpdate(bundle({ importedSha: null }));
      assert.equal(result.latestSha, "fresh");
      assert.equal(result.hasUpdate, false);
    },
  );
});

test("checkBundleUpdate: a different latest sha than importedSha flags hasUpdate", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ sha: "newer-sha" }), { status: 200 }),
    async () => {
      const result = await checkBundleUpdate(bundle({ importedSha: "older-sha" }));
      assert.equal(result.latestSha, "newer-sha");
      assert.equal(result.hasUpdate, true);
    },
  );
});

test("checkBundleUpdate: a matching latest sha is up to date", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ sha: "same-sha" }), { status: 200 }),
    async () => {
      const result = await checkBundleUpdate(bundle({ importedSha: "same-sha" }));
      assert.equal(result.hasUpdate, false);
    },
  );
});

test("checkBundleUpdate: the second call within the cache window makes no second fetch", async () => {
  const b = bundle({ importedSha: "old" });
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return new Response(JSON.stringify({ sha: "new" }), { status: 200 }); },
    async () => {
      await checkBundleUpdate(b);
      const second = await checkBundleUpdate(b);
      assert.equal(second.latestSha, "new");
      assert.equal(second.hasUpdate, true);
    },
  );
  assert.equal(calls, 1);
});

test("checkBundleUpdate: a host error answers from the cache instead of throwing", async () => {
  const b = bundle({ importedSha: "old" });
  await withFetch(
    async () => new Response(JSON.stringify({ sha: "cached-sha" }), { status: 200 }),
    async () => { await checkBundleUpdate(b); },
  );
  await withFetch(
    async () => { throw new Error("network down"); },
    async () => {
      const result = await checkBundleUpdate(b);
      assert.equal(result.latestSha, "cached-sha");
      assert.equal(result.hasUpdate, true);
    },
  );
});

test("checkBundleUpdate: a host error with nothing cached yet answers null, not throws", async () => {
  await withFetch(
    async () => { throw new Error("network down"); },
    async () => {
      const result = await checkBundleUpdate(bundle({ importedSha: "old" }));
      assert.equal(result.latestSha, null);
      assert.equal(result.hasUpdate, false);
    },
  );
});

test("checkBundleUpdate: a bundle with no source repo info is answered without any fetch", async () => {
  let called = false;
  await withFetch(
    async () => { called = true; return new Response("{}", { status: 200 }); },
    async () => {
      const result = await checkBundleUpdate({ id: "x", sourceOwner: "", sourceRepo: "" });
      assert.deepEqual(result, { latestSha: null, hasUpdate: false });
    },
  );
  assert.equal(called, false);
});
