// Editing a receiving provider must be able to replace its secrets. The update
// path once checked the incoming key against the `{ required, optional }` wrapper
// instead of its lists, so every replacement was silently dropped and the admin
// kept polling with the old credential (Binance: "-2008 Invalid Api-Key ID").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-provider-secrets-"));

const { createProvider, updateProvider, getProviderWithSecrets } = await import(
  "../src/lib/db/repos/paymentProvidersRepo.js"
);

const binanceInput = (secrets) => ({
  kind: "binance",
  name: "Binance",
  config: { payUid: "59483156", accountName: "Ray" },
  secrets,
});

test("updating a provider replaces a secret that is sent and keeps one that is blank", async () => {
  const { provider } = await createProvider(binanceInput({ apiKey: "old-key-1111", apiSecret: "old-secret-2222" }));

  await updateProvider(provider.id, { secrets: { apiKey: "new-key-3333", apiSecret: "" } });
  const stored = await getProviderWithSecrets(provider.id);

  assert.equal(stored.secrets.apiKey, "new-key-3333");
  assert.equal(stored.secrets.apiSecret, "old-secret-2222");
});

test("updating a provider ignores a secret name that kind does not have", async () => {
  const { provider } = await createProvider(binanceInput({ apiKey: "k-1111", apiSecret: "s-2222" }));

  await updateProvider(provider.id, { secrets: { token: "not-a-binance-secret" } });
  const stored = await getProviderWithSecrets(provider.id);

  assert.equal(stored.secrets.token, undefined);
  assert.equal(stored.secrets.apiKey, "k-1111");
});
