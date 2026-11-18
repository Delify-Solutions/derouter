// Module-resolution hook for tests that import app code written for Next.js: maps the "@/"
// alias to src/ and the bare "open-sse/" specifier to the engine folder, adding ".js" or
// "/index.js" the way the bundler does. Plain `node --test` resolves neither.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url);

function toFile(base) {
  const p = fileURLToPath(base);
  for (const candidate of [p, `${p}.js`, `${p}.mjs`, `${p}/index.js`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let target = null;
  if (specifier.startsWith("@/")) target = toFile(new URL(`src/${specifier.slice(2)}`, ROOT));
  else if (specifier.startsWith("open-sse/")) target = toFile(new URL(specifier, ROOT));
  if (target) return { url: target, shortCircuit: true };
  return nextResolve(specifier, context);
}
