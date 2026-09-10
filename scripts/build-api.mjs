/**
 * Bundle the gate into one self-contained ESM file for serverless: `node scripts/build-api.mjs`.
 *
 * Why bundle rather than emit with tsc. The repo runs entirely under tsx: tsconfig sets noEmit, the
 * workspace packages point `main` at `src/index.ts`, and 96 internal imports use NodeNext `.js`
 * specifiers on files that are actually `.ts`. Emitting JS would therefore produce output whose
 * cross-package imports still resolve to TypeScript at runtime. Bundling makes every one of those
 * imports disappear into a single file, so the function has nothing left to resolve.
 *
 * Output goes to dist-api/, not api/ — anything inside api/ becomes its own HTTP endpoint on Vercel,
 * and the bundle is a library, not a route.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-api");
if (!existsSync(out)) mkdirSync(out, { recursive: true });

/**
 * NodeNext writes `./routes.js` where the file on disk is `./routes.ts`. esbuild does not rewrite
 * that, so this maps a relative `.js` specifier onto its `.ts` sibling when one exists.
 */
const nodeNextTs = {
  name: "nodenext-js-to-ts",
  setup(b) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const ts = resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts");
      return existsSync(ts) ? { path: ts } : undefined;
    });
  },
};

const result = await build({
  entryPoints: [join(root, "packages/gate/src/serverless.ts")],
  outfile: join(out, "gate.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  plugins: [nodeNextTs],
  alias: {
    "@charter/shared": join(root, "packages/shared/src/index.ts"),
    "@charter/sdk": join(root, "packages/sdk/src/index.ts"),
  },
  // pg ships an optional native binding it only requires lazily; keep it out of the graph.
  external: ["pg-native"],
  // Fastify and avvio are CommonJS and call require() at load time. In an ESM bundle esbuild's
  // shim cannot service that, so `require` is reinstated from import.meta.url. Without this the
  // bundle dies on "Dynamic require of node:events is not supported" before serving anything.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
  metafile: true,
});

if (result.warnings.length) for (const w of result.warnings) console.warn("  warn:", w.text);
console.log(`[build-api] dist-api/gate.mjs  ${(statSync(join(out, "gate.mjs")).size / 1024).toFixed(0)} KB`);
