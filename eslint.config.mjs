import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next registers the TypeScript plugin only for .ts/.tsx files, but the
// plain-JS sources use dynamic `require()` for optional native modules and carry
// `eslint-disable-next-line @typescript-eslint/no-require-imports` directives. Without the
// plugin registered for JS, those directives are reported as "definition for rule not
// found", which is a hard error. Reuse the instance nextVitals already loaded so we do
// not depend on a package that only exists transitively.
const tsPlugin = nextVitals.find((config) => config?.plugins?.["@typescript-eslint"])
  ?.plugins["@typescript-eslint"];

// eslint-config-next 16 ships the React Compiler rule set at "error". The dashboard was
// written before those rules existed and reports ~150 pre-existing findings, so keep them
// as warnings: they are advisory, and a hard failure would block unrelated PRs.
const advisoryRules = {
  "react-hooks/set-state-in-effect": "warn",
  "react-hooks/immutability": "warn",
  "react-hooks/purity": "warn",
  "react-hooks/refs": "warn",
  "react/no-unescaped-entities": "warn",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...(tsPlugin ? { plugins: { "@typescript-eslint": tsPlugin } } : {}),
    rules: {
      ...advisoryRules,
      ...(tsPlugin ? { "@typescript-eslint/no-require-imports": "warn" } : {}),
    },
  },
  // These entry points are CommonJS on purpose: the standalone server and the published CLI
  // both ship as CJS (package.json has no "type": "module"), so `require()` is the correct
  // primitive there. Converting them to ESM would break the packaged layout — the CLI is
  // executed straight from the published tree and custom-server.js is started by `node` with
  // no build step. src/lib/updater/updater.js is copied verbatim out of the bundle into
  // DATA_DIR/runtime/updater/ and spawned as a detached plain-Node process by appUpdater.js,
  // so it is also CJS by contract. Keep the rule on everywhere else, where a `require()` is a
  // real defect.
  {
    files: ["custom-server.js", "src/mitm/**/*.js", "cli/**/*.js", "scripts/**/*.js", "src/lib/updater/updater.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Server/worker code logs to stdout by design; only flag accidental raw console.log.
  {
    files: ["src/**/*.js", "open-sse/**/*.js"],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Dev-server output from a sibling worktree run; generated bundles, not source.
    ".next-w2/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "logs/**",
    // Tests and one-off fixture scripts are not part of the app lint surface.
    "open-sse/test/**",
    "test/**",
  ]),
]);

export default eslintConfig;
