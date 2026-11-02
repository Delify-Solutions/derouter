// Pages must not be stored by a reverse-proxy cache in front of the app, or it
// keeps serving the previous build after a deploy (custom-server.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Requiring the module patches http.createServer with the request wrapper.
const { shareableCacheControl } = require("../custom-server.js");

test("prerendered page headers are made private", () => {
  assert.equal(shareableCacheControl("s-maxage=31536000"), "private, no-cache");
  assert.equal(shareableCacheControl("s-maxage=300, stale-while-revalidate=31535700"), "private, no-cache");
  assert.equal(shareableCacheControl(["S-MAXAGE=60"]), "private, no-cache");
});

test("hashed assets, dynamic pages and absent headers are left alone", () => {
  assert.equal(shareableCacheControl("public, max-age=31536000, immutable"), null);
  assert.equal(shareableCacheControl("private, no-cache, no-store, max-age=0, must-revalidate"), null);
  assert.equal(shareableCacheControl("public, max-age=60, must-revalidate"), null);
  assert.equal(shareableCacheControl(undefined), null);
});

// The header that reaches the wire, for each way a handler can send it.
const ROUTES = {
  "/implicit": (res) => { res.setHeader("Cache-Control", "s-maxage=31536000"); res.end("x"); },
  "/object": (res) => { res.writeHead(200, { "Cache-Control": "s-maxage=31536000" }); res.end("x"); },
  "/reason": (res) => { res.writeHead(200, "OK", { "cache-control": "s-maxage=31536000" }); res.end("x"); },
  "/flat": (res) => { res.writeHead(200, ["Cache-Control", "s-maxage=31536000"]); res.end("x"); },
  "/not-modified": (res) => { res.setHeader("Cache-Control", "s-maxage=31536000"); res.statusCode = 304; res.end(); },
  "/asset": (res) => { res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); res.end("x"); },
  "/dynamic": (res) => { res.writeHead(200, { "Cache-Control": "private, no-store" }); res.end("x"); },
};

const server = http.createServer((req, res) => ROUTES[req.url](res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());

async function cacheControl(path) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  await res.arrayBuffer();
  return res.headers.get("cache-control");
}

test("the wrapper rewrites s-maxage on every writeHead path", async () => {
  for (const path of ["/implicit", "/object", "/reason", "/flat", "/not-modified"]) {
    assert.equal(await cacheControl(path), "private, no-cache", path);
  }
  assert.equal(await cacheControl("/asset"), "public, max-age=31536000, immutable");
  assert.equal(await cacheControl("/dynamic"), "private, no-store");
});
