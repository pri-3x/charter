/**
 * Assemble the static site for Vercel (or any static host) out of `packages/console/public`.
 *
 * Locally the gate serves the landing page at `/` and the console under the `/console/` prefix, and
 * the HTML hard-codes that layout (`/console/charter.css`, links to `/console/`). Rather than paper
 * over it with host rewrites, this copies the files into the shape those absolute paths already
 * expect, so the deployed tree and the locally served tree resolve identically:
 *
 *   dist-web/index.html          <- landing.html
 *   dist-web/console/index.html  <- console index.html
 *   dist-web/console/charter.css
 *   dist-web/console/charter.js
 *
 * There is no bundling, minification or templating here on purpose — the console has no build step,
 * and adding one just to deploy would mean the thing that ships is not the thing that was tested.
 */
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = join(root, "packages", "console", "public");
const out = join(root, "dist-web");

if (!existsSync(src)) {
  console.error(`[build-static] source missing: ${src}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "console"), { recursive: true });

const copy = (from, to) => {
  cpSync(join(src, from), join(out, to));
  console.log(`  ${from}  ->  ${to}  (${statSync(join(out, to)).size} bytes)`);
};

console.log("[build-static] assembling dist-web/");
copy("landing.html", "index.html");
copy("index.html", join("console", "index.html"));
copy("charter.css", join("console", "charter.css"));
copy("charter.js", join("console", "charter.js"));

console.log("[build-static] done");
