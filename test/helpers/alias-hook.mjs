// Node module-resolution hook for tests that import router engine code (open-sse/*) which
// reaches the app through the Next.js "@/" alias. Only the alias the engine really uses on the
// code paths under test is mapped: "@/lib/usageDb.js" to the in-memory stub-usageDb.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/usageDb.js") {
    return { url: new URL("./stub-usageDb.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
