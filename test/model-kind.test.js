// Text vs image detection behind the model test button and the combo pickers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guessModelKind, detectModelKind } from "../src/lib/models/modelKind.js";

const NODE_ID = "openai-compatible-chat-abc";
const nodes = [
  { id: NODE_ID, prefix: "bca", apiType: "chat" },
  { id: "openai-compatible-images-def", prefix: "vi", apiType: "images" },
];

test("names that are image generators are guessed as image, everything else as text", () => {
  for (const id of ["Qwen/Qwen-Image-2.1", "flux-1-dev", "dall-e-3", "stable-diffusion-xl", "gpt-image-1", "imagen-4.0"]) {
    assert.equal(guessModelKind(id), "image", id);
  }
  for (const id of ["gpt-4o", "claude-3-opus", "Qwen3-235B", "deepseek-chat", "imagine-text-llm-x", ""]) {
    assert.equal(guessModelKind(id), "llm", id);
  }
});

test("a type recorded on the node wins over the name, in both directions", () => {
  const customModels = [
    { providerAlias: NODE_ID, id: "mystery-model", type: "image" },
    { providerAlias: NODE_ID, id: "Qwen-Image-Chatty", type: "llm" },
  ];
  assert.equal(detectModelKind(`bca/mystery-model`, { customModels, nodes }), "image");
  assert.equal(detectModelKind(`${NODE_ID}/mystery-model`, { customModels, nodes }), "image");
  assert.equal(detectModelKind(`bca/Qwen-Image-Chatty`, { customModels, nodes }), "llm");
});

test("a model on an image-only node is an image even with an ordinary name", () => {
  assert.equal(detectModelKind("vi/anything", { nodes }), "image");
});

test("a combo answers with its own kind", () => {
  const combos = [{ name: "fox-image", kind: "image" }, { name: "fox-chat", kind: null }];
  assert.equal(detectModelKind("fox-image", { combos }), "image");
  assert.equal(detectModelKind("fox-chat", { combos }), "llm");
});

test("an unknown alias falls back to the name guess", () => {
  assert.equal(detectModelKind("nobody/flux-schnell", {}), "image");
  assert.equal(detectModelKind("nobody/gpt-4o", {}), "llm");
});
