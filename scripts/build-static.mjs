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

/**
 * Pull the question/answer pairs out of the compliance grid in the rendered HTML. Returns schema.org
 * Question nodes. Throws if it finds none, because silently emitting an empty FAQPage would be worse
 * than emitting nothing at all.
 */
function faqFromPage(markup) {
  // Sliced on explicit string boundaries, not a regex. A lazy [\s\S]*? stops at the first nested
  // </div>, the match then fails, and falling back to the whole document silently swept in the three
  // feature headings from section 01 — which are statements, not questions. Fail loudly instead.
  const OPEN = '<div class="evid">';
  const CLOSE = 'id="reportBtn"'; // the first thing after the grid closes
  const a = markup.indexOf(OPEN);
  const b = markup.indexOf(CLOSE, a);
  if (a < 0 || b < 0) {
    console.error("[build-static] could not locate the compliance grid — FAQ markup would be wrong.");
    process.exit(1);
  }
  const scope = markup.slice(a + OPEN.length, b);
  const text = (h) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  const out = [];
  const re = /<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(scope))) {
    const name = text(m[1]);
    const answer = text(m[2]);
    if (name && answer) out.push({ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text: answer } });
  }
  if (!out.length) {
    console.error("[build-static] found no Q/A pairs for the FAQ — has the compliance grid changed?");
    process.exit(1);
  }
  return out;
}

// JSON-LD. Only claims that are demonstrably true from the repo — no ratings, no prices, no invented
// org details. Structured data that overstates is worse than none: it is the one part of the page a
// search engine treats as an assertion of fact rather than marketing.
//
// Emitted as a @graph so the three entities can reference each other by @id rather than repeating
// themselves, which is what lets the FAQ be attributed to the software and the software to the org.
const ld = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": abs("/#org"),
      name: "Charter",
      url: abs("/"),
      logo: { "@type": "ImageObject", url: abs("/icon.png"), width: 512, height: 512 },
    },
    {
      "@type": "SoftwareApplication",
      "@id": abs("/#software"),
      name: "Charter",
      url: abs("/"),
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI agent authorization and audit",
      operatingSystem: "Linux, macOS",
      description:
        "A policy gate that sits between an AI agent and the tools it calls, fused with a tamper-evident audit ledger. Every action is checked against a written authority before it runs; every verdict is committed to a hash chain sealed by signed Merkle checkpoints.",
      softwareVersion: "prototype",
      isAccessibleForFree: true,
      publisher: { "@id": abs("/#org") },
      featureList: [
        "Runtime policy gate: allow, deny, or escalate every tool call before it executes",
        "Human approval over Telegram, with the approver's identity recorded",
        "Append-only hash-chained ledger enforced by database role permissions",
        "Signed Ed25519 Merkle checkpoints anchoring ranges of history",
        "Independent verifier that shares no code with the writer",
        "Attestation export mapped to SOC 2, EU AI Act and RBI control references",
      ],
    },
    {
      // Derived from the rendered page, not written here. Google requires FAQ markup to mirror
      // content the visitor can actually see, and hand-writing richer answers is exactly how that
      // requirement gets quietly broken: an earlier draft of this asserted things like "self-approval
      // is refused" that are true of the product but appear nowhere on this page. Extracting the
      // question and answer from section 06's own markup makes the two impossible to desynchronise —
      // edit the copy and the structured data follows.
      "@type": "FAQPage",
      "@id": abs("/#faq"),
      about: { "@id": abs("/#software") },
      mainEntity: faqFromPage(html),
    }
  ],
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
// Inline the stylesheet into the landing page. It is the only render-blocking request left, and at
// ~5.7 KB over the wire the round trip costs more than the bytes. The console keeps the external
// file: it is a different page, it is noindex, and it benefits from the shared cache entry.
const cssPath = join(src, "charter.css");
if (existsSync(cssPath)) {
  const css = readFileSync(cssPath, "utf8");
  const before = html.length;
  html = html.replace(
    '<link rel="stylesheet" href="/console/charter.css" />',
    "<style>\n" + css + "\n    </style>",
  );
  if (html.length === before) console.warn("  css inline    ->  SKIPPED: stylesheet link not found");
  else console.log(`  css inline     ->  ${css.length} bytes, no blocking request left`);
}

writeFileSync(indexPath, html);
console.log(`  seo            ->  canonical + og + json-ld at ${origin}`);

writeFileSync(
  join(out, "sitemap.xml"),
  // `lastmod` is the one hint here Google actually acts on — changefreq and priority are ignored, but
  // are cheap and still read by other crawlers. Taken from the landing page's own mtime so it tells
  // the truth about when the content changed, rather than resetting on every unrelated rebuild.
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${abs("/")}</loc>\n    <lastmod>${new Date(statSync(join(src, "landing.html")).mtime).toISOString().slice(0, 10)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
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

// A 404 that looks like the site. Vercel's default is a bare white page, which for a one-page site
// is the most likely thing a visitor sees after a stale link or a typo.
const notFound = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found — Charter</title>
    <meta name="robots" content="noindex" />
    <style>
      :root { color-scheme: light dark }
      body { margin:0; min-height:100svh; display:grid; place-content:center; gap:14px;
             background:#f2f0ea; color:#171614; text-align:center; padding:24px;
             font-family:"Helvetica Neue",Inter,-apple-system,system-ui,sans-serif }
      .k { font-family:ui-monospace,Menlo,monospace; font-size:10px; letter-spacing:.11em;
           text-transform:uppercase; color:#ff5c1a }
      h1 { margin:0; font-size:clamp(26px,4vw,40px); letter-spacing:-.035em; font-weight:700 }
      p { margin:0; color:#55524b; max-width:44ch }
      a { color:#171614; text-underline-offset:3px }
      @media (prefers-color-scheme: dark) {
        body { background:#232323; color:#f2f0ea } p { color:#a8a49b } a { color:#f2f0ea }
      }
    </style>
  </head>
  <body>
    <p class="k">404</p>
    <h1>Nothing is charted here.</h1>
    <p>That page does not exist. <a href="/">Go to the start</a>.</p>
  </body>
</html>
`;
writeFileSync(join(out, "404.html"), notFound);
console.log("  404.html       ->  styled, noindex");

console.log("[build-static] done");
