// COSY device identity: one credential, one machine id.
//
// The bug this pins: chat and model-list used different values, and a missing
// stored id fell back to `uuidv4()` per request. Two accounts could also sign
// with ids derived from nothing stable, so the upstream saw one device for
// requests that came from two — which is how sessions and queue state mix.
import { test } from "node:test";
import assert from "node:assert/strict";

const { connectionMachineId, buildCosyHeaders, resolveMachineId } = await import(
  "../open-sse/shared/qoder/cosy.js"
);

const conn = (connectionId, userId, extra = {}) => ({
  connectionId,
  accessToken: `dt-${userId}`,
  providerSpecificData: { userId },
  ...extra,
});

test("the same connection signs with one machine id on every request", () => {
  const a = conn("conn-a", "user-a");
  const first = connectionMachineId(a);
  const second = connectionMachineId({ ...a });
  assert.equal(first, second);
  assert.equal(buildCosyHeaders(Buffer.alloc(0), "https://x/algo/api", {
    userId: "user-a", authToken: "dt-user-a", machineId: first,
  })["Cosy-Machineid"], first);
});

test("two accounts on one router get different machine ids", () => {
  assert.notEqual(connectionMachineId(conn("conn-a", "user-a")), connectionMachineId(conn("conn-b", "user-b")));
});

test("a rotating token does not move the machine id", () => {
  const before = conn("conn-pat", "user-p");
  const after = { ...before, accessToken: "jt-rotated" };
  assert.equal(connectionMachineId(before), connectionMachineId(after));
});

test("a stored machine id wins over derivation", () => {
  const stored = "11111111-2222-5333-a444-555555555555";
  assert.equal(connectionMachineId(conn("conn-s", "user-s", {
    providerSpecificData: { userId: "user-s", machineId: stored },
  })), stored);
});

test("the derived id is shaped like a uuid", () => {
  assert.match(
    connectionMachineId(conn("conn-a", "user-a")),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
});

test("nothing identifying the caller yields a fresh id, never a shared constant", () => {
  assert.notEqual(resolveMachineId({}), resolveMachineId({}));
});
