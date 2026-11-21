// Module-resolution hook for tests that import Next.js route handlers: "next/server"
// is resolved by the bundler but not by plain Node ESM (the package has no exports
// map), so it is pointed at the package's own "next/server.js". Register it next to
// src-alias-hook.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  return nextResolve(specifier, context);
}
