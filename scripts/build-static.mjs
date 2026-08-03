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
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { socialCard, appIcon } from "./lib/social-card.mjs";

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

// The recorded run, fetched by the landing page with a relative URL — so it sits beside it at the
// root. Not copied into console/: charter.js has no replay path, and shipping a file nothing reads
// invites someone to assume the console has one.
if (existsSync(join(src, "replay.json"))) {
  copy("replay.json", "replay.json");
} else {
  console.warn("  replay.json missing — the hosted page will show the offline state.");
  console.warn("  regenerate it with: node scripts/record-replay.mjs (needs a running local gate)");
}

// ---------------------------------------------------------------------------------------- SEO ----
// The one canonical home. Deliberately NOT falling back to VERCEL_PROJECT_PRODUCTION_URL:
// the site is reachable on both usecharter.xyz and the project's *.vercel.app host, and pointing the
// canonical at whichever host built it would tell crawlers the vercel.app copy is the original.
// Every absolute URL — canonical, og:url, og:image, the sitemap — must name the real domain wherever
// the build happens to run. SITE_URL still overrides, for a staging domain or a rename.
const CANONICAL_ORIGIN = "https://usecharter.xyz";
const origin = (process.env.SITE_URL || CANONICAL_ORIGIN).replace(/\/$/, "");

const indexPath = join(out, "index.html");
let html = readFileSync(indexPath, "utf8");

const abs = (p) => origin + p;
// JSON-LD: only claims that are demonstrably true from the repo. No ratings, no prices, no
// invented org details — structured data that overstates is worse than none.
const ld = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Charter",
  url: abs("/"),
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "AI agent authorization and audit",
  operatingSystem: "Linux, macOS",
  description:
    "A policy gate that sits between an AI agent and the tools it calls, fused with a tamper-evident audit ledger. Every action is checked against a written authority before it runs; every verdict is committed to a hash chain sealed by signed Merkle checkpoints.",
  softwareVersion: "prototype",
  isAccessibleForFree: true,
  author: { "@type": "Organization", name: "Charter" },
};

html = html.replace(
  '<link rel="canonical" href="/" />',
  [
    `<link rel="canonical" href="${abs("/")}" />`,
    `    <meta property="og:url" content="${abs("/")}" />`,
    `    <meta property="og:image" content="${abs("/og.png")}" />`,
    `    <meta property="og:image:width" content="1200" />`,
    `    <meta property="og:image:height" content="630" />`,
    `    <meta property="og:image:alt" content="The Charter mark — a keyhole with the gate barred across it — beside the hash chain it writes." />`,
    `    <meta name="twitter:image" content="${abs("/og.png")}" />`,
    `    <script type="application/ld+json">${JSON.stringify(ld)}</script>`,
  ].join("\n"),
);
writeFileSync(indexPath, html);
console.log(`  seo            ->  canonical + og + json-ld at ${origin}`);

writeFileSync(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${abs("/")}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
);
console.log("  sitemap.xml    ->  1 url (the console is intentionally excluded)");

// The console is an operator UI for a gate, not content. It must never be indexed — and the sitemap
// above lists only the landing page for the same reason.
writeFileSync(
  join(out, "robots.txt"),
  ["User-agent: *", "Allow: /", "Disallow: /console/", "", `Sitemap: ${origin}/sitemap.xml`].join("\n") +
    "\n",
);
console.log("  robots.txt     ->  allow /, disallow /console/");

// ------------------------------------------------------------------------------------- images ----
// Seeded from the recorded chain when there is one, so the card's silhouette is this deployment's
// own hashes rather than an arbitrary pattern.
let seed = [140, 90, 200, 60, 175, 110, 240, 75, 155, 205, 95, 185, 130, 220];
try {
  const rp = JSON.parse(readFileSync(join(src, "replay.json"), "utf8"));
  const bytes = (rp.chain ?? [])
    .map((e) => parseInt(String(e.entry_hash).replace(/^sha256:/, "").slice(0, 2), 16))
    .filter((n) => Number.isFinite(n));
  if (bytes.length >= 4) seed = bytes;
} catch {
  /* no recording — the default seed is fine */
}

writeFileSync(join(out, "og.png"), socialCard(seed));
console.log(`  og.png         ->  1200x630 (${statSync(join(out, "og.png")).size} bytes)`);
writeFileSync(join(out, "icon.png"), appIcon());
console.log(`  icon.png       ->  512x512 (${statSync(join(out, "icon.png")).size} bytes)`);

console.log("[build-static] done");
