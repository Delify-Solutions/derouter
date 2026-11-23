// POST /api/providers/[id]/clone — duplicate a Compatible connection (endpoint,
// API key, model config) into a brand new one, without ever putting the real key
// on the wire to the browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-providers-clone-"));

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createProviderConnection, getProviderConnectionById } = await import("../src/lib/db/repos/connectionsRepo.js");
const { POST } = await import("../src/app/api/providers/[id]/clone/route.js");

await getAdapter();

const call = (id) =>
  POST(new Request(`https://admin.example/api/providers/${id}/clone`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

test("clones a Compatible connection: new id, suffixed name, key/model config copied, original untouched", async () => {
  const source = await createProviderConnection({
    provider: "openai-compatible-acme",
    authType: "apikey",
    name: "Acme primary",
    apiKey: "sk-real-secret",
    providerSpecificData: { baseUrl: "https://acme.example/v1", prefix: "acme/", apiType: "openai", customModels: ["acme-large"] },
  });

  const res = await call(source.id);
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.notEqual(body.connection.id, source.id);
  assert.equal(body.connection.name, "Acme primary (sao chép)");
  assert.equal(body.connection.apiKey, undefined, "the clone response never carries the plaintext key");

  // The clone actually HAS the real key and config, server-side.
  const stored = await getProviderConnectionById(body.connection.id);
  assert.equal(stored.apiKey, "sk-real-secret");
  assert.equal(stored.providerSpecificData.baseUrl, "https://acme.example/v1");
  assert.deepEqual(stored.providerSpecificData.customModels, ["acme-large"]);

  // The original is untouched.
  const original = await getProviderConnectionById(source.id);
  assert.equal(original.name, "Acme primary");
  assert.equal(original.apiKey, "sk-real-secret");
});

test("cloning the same connection twice does not collide on name", async () => {
  const source = await createProviderConnection({
    provider: "openai-compatible-twice",
    authType: "apikey",
    name: "Twice",
    apiKey: "sk-1",
  });

  const first = await (await call(source.id)).json();
  const second = await (await call(source.id)).json();
  assert.equal(first.connection.name, "Twice (sao chép)");
  assert.equal(second.connection.name, "Twice (sao chép 2)");
  assert.notEqual(first.connection.id, second.connection.id);
});

test("a non-Compatible connection (plain apikey provider) is refused", async () => {
  const source = await createProviderConnection({
    provider: "acme-plain",
    authType: "apikey",
    name: "Plain",
    apiKey: "sk-plain",
  });
  const res = await call(source.id);
  assert.equal(res.status, 400);
});

test("cloning an Anthropic-compatible connection works too", async () => {
  const source = await createProviderConnection({
    provider: "anthropic-compatible-beta",
    authType: "apikey",
    name: "Beta",
    apiKey: "sk-beta",
    providerSpecificData: { baseUrl: "https://beta.example", prefix: "beta/" },
  });
  const res = await call(source.id);
  assert.equal(res.status, 201);
  const body = await res.json();
  const stored = await getProviderConnectionById(body.connection.id);
  assert.equal(stored.apiKey, "sk-beta");
});

test("an unknown connection id is a 404", async () => {
  const res = await call("no-such-connection");
  assert.equal(res.status, 404);
});
