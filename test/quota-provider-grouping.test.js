// /dashboard/quota groups account cards by provider (collapsed by default) so
// N accounts on one provider stop making the page scroll forever.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/quota-utils-hook.mjs", import.meta.url);

const { groupConnectionsByProvider } = await import(
  "../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
);

test("groups by provider, first-appearance order, original order preserved within a group", () => {
  const connections = [
    { id: "a1", provider: "claude" },
    { id: "k1", provider: "kiro" },
    { id: "a2", provider: "claude" },
    { id: "k2", provider: "kiro" },
    { id: "c1", provider: "codex" },
  ];
  const groups = groupConnectionsByProvider(connections);
  assert.deepEqual(groups.map((g) => g.provider), ["claude", "kiro", "codex"]);
  assert.deepEqual(groups.find((g) => g.provider === "claude").connections.map((c) => c.id), ["a1", "a2"]);
  assert.deepEqual(groups.find((g) => g.provider === "kiro").connections.map((c) => c.id), ["k1", "k2"]);
  assert.deepEqual(groups.find((g) => g.provider === "codex").connections.map((c) => c.id), ["c1"]);
});

test("an empty list produces no groups; a missing provider groups under the empty-string key", () => {
  assert.deepEqual(groupConnectionsByProvider([]), []);
  const groups = groupConnectionsByProvider([{ id: "x" }, { id: "y", provider: "" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].provider, "");
  assert.deepEqual(groups[0].connections.map((c) => c.id), ["x", "y"]);
});

// Every custom OpenAI/Anthropic-compatible node has its own generated provider
// id (openai-compatible-chat-<uuid>, anthropic-compatible-<uuid>): grouping by
// the raw id would make one singleton group per node — as long a list as no
// grouping at all once an account has several of them.
test("custom OpenAI/Anthropic-compatible nodes bucket into one umbrella group each, not one group per node", () => {
  const connections = [
    { id: "o1", provider: "openai-compatible-chat-aaaa" },
    { id: "o2", provider: "openai-compatible-chat-bbbb" },
    { id: "a1", provider: "anthropic-compatible-cccc" },
    { id: "c1", provider: "claude" },
  ];
  const groups = groupConnectionsByProvider(connections);
  assert.equal(groups.length, 3, "two distinct compatible node ids collapse into one group");
  const openaiGroup = groups.find((g) => g.connections.some((c) => c.id === "o1"));
  assert.equal(openaiGroup.provider, "__openai_compatible__");
  assert.equal(openaiGroup.label, "OpenAI Compatible");
  assert.deepEqual(openaiGroup.connections.map((c) => c.id), ["o1", "o2"]);
  const anthropicGroup = groups.find((g) => g.connections.some((c) => c.id === "a1"));
  assert.equal(anthropicGroup.provider, "__anthropic_compatible__");
  assert.equal(anthropicGroup.label, "Anthropic Compatible");
  const claudeGroup = groups.find((g) => g.provider === "claude");
  assert.equal(claudeGroup.label, "claude", "a real registry provider keeps its own group and raw id as the label");
});
