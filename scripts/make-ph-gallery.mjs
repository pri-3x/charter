/**
 * Product Hunt gallery images: `node scripts/make-ph-gallery.mjs` → media/ph-*.png
 *
 * Four 1270x760 panels (PH's recommended gallery size), drawn with the same Raster + bitfont code as
 * the OG card and the teaser, so the launch page looks like the product rather than like a template.
 *
 * Every number, verdict, rule id and hash is read from packages/console/public/replay.json — a real
 * recorded run against a live gate. The first image is the one PH uses as the social preview when the
 * launch is shared, so it carries the claim; the rest carry the evidence.
 */
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { Raster } from "./lib/png.mjs";
import { drawText, textWidth, fitScale } from "./lib/bitfont.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(root, "media");

const W = 1270;
const H = 760;

const CARBON = [0x23, 0x23, 0x23];
const PAPER = [0xf2, 0xf0, 0xea];
const INK = [0x17, 0x16, 0x14];
const ACCENT = [0xff, 0x5c, 0x1a];
const ALLOW = [0x8e, 0xc0, 0x63];
const DENY = [0xef, 0x6a, 0x4c];
const HOLD = [0xf0, 0xab, 0x2e];
const DIM = [0x8b, 0x87, 0x7e];

const replay = JSON.parse(readFileSync(join(root, "packages/console/public/replay.json"), "utf8"));
const money = (r) => (r > 0 ? "₹" + r.toLocaleString("en-IN") : "-");
const VC = { ALLOW, DENY, ESCALATE: HOLD };
const SHORT = { refund: "REFUND", send_email: "EMAIL", initiate_payout: "PAYOUT", lookup_order: "LOOKUP", delete_record: "DELETE" };

// ------------------------------------------------------------------------------------ helpers ----
const PAD = 70;
const SAFE = W - PAD * 2;

/** Left-aligned line, auto-shrunk so it cannot run past the safe width. */
function line(img, text, x, y, scale, rgb, a = 1, tracking = 2) {
  const s = fitScale(text, W - x - PAD, scale, tracking);
  drawText(img, text, x, y, s, rgb, a, tracking);
  return s;
}
/**
 * Draw inside an explicit width, shrinking to fit. Bare drawText() does not fit, which is how the
 * first cut of this set clipped its own footer off the right edge.
 */
function capped(img, text, x, y, maxW, scale, rgb, a = 1, tracking = 2) {
  drawText(img, text, x, y, fitScale(text, maxW, scale, tracking), rgb, a, tracking);
}

function rightAt(img, text, xRight, y, scale, rgb, a = 1, tracking = 2) {
  drawText(img, text, Math.round(xRight - textWidth(text, scale, tracking)), y, scale, rgb, a, tracking);
}
function dots(img, step, a, colour) {
  for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) img.blend(x, y, colour, a);
}
/** The keyhole, cut out of a tile — the void is what makes it read as an aperture. */
function mark(img, cx, cy, size, hole) {
  const s = size / 32;
  const X = (u) => cx + (u - 16) * s;
  const Y = (v) => cy + (v - 16) * s;
  img.roundRect(X(2), Y(2), 28 * s, 28 * s, 7 * s, PAPER);
  img.disc(X(16), Y(13.5), 4.6 * s, hole);
  img.poly([[X(13.7), Y(17.5)], [X(18.3), Y(17.5)], [X(20), Y(25)], [X(12), Y(25)]], hole);
  img.capsule(X(10.4), Y(19.4), 11.2 * s, 2.9 * s, ACCENT);
}
/** The eyebrow every panel carries, so the set reads as one system. */
function eyebrow(img, n, label, colour = DIM) {
  drawText(img, n, PAD, PAD, 3, ACCENT, 1, 2);
  drawText(img, label, PAD + textWidth(n, 3, 2) + 22, PAD, 3, colour, 0.85, 2);
  img.rect(PAD, PAD + 34, SAFE, 1, colour, 0.22);
}

// -------------------------------------------------------------------------------------- panels ----
/** 01 — the claim. PH uses the first gallery image as the social preview. */
function panelClaim() {
  const img = new Raster(W, H, CARBON);
  dots(img, 26, 0.05, PAPER);
  mark(img, 150, 150, 128, CARBON);
  line(img, "YOUR AI CAN SPEND MONEY.", PAD, 300, 9, PAPER);
  line(img, "CHARTER DECIDES WHEN IT CAN.", PAD, 380, 9, PAPER);
  img.rect(PAD, 460, 420, 6, ACCENT);
  line(img, "A POLICY GATE YOUR AGENT HAS TO ASK BEFORE IT ACTS,", PAD, 520, 4, DIM);
  line(img, "AND A LEDGER NOBODY CAN EDIT. NOT EVEN US.", PAD, 562, 4, DIM);
  rightAt(img, "USECHARTER.XYZ", W - PAD, H - PAD - 20, 4, PAPER, 0.8);
  return img.toPNG();
}

/** 02 — the three outcomes, from the recorded run. */
function panelDecision() {
  const img = new Raster(W, H, PAPER);
  dots(img, 26, 0.05, INK);
  eyebrow(img, "01", "THE DECISION", [0x55, 0x52, 0x4b]);
  line(img, "ALLOWED, HELD, OR BLOCKED.", PAD, 130, 8, INK);

  const rows = [
    replay.rows.find((r) => r.tool === "refund" && r.verdict === "ALLOW"),
    replay.rows.find((r) => r.tool === "refund" && r.verdict === "ESCALATE"),
    replay.rows.find((r) => r.tool === "initiate_payout" && r.verdict === "DENY"),
  ].filter(Boolean);
  const why = {
    ALLOW: "INSIDE THE SPENDING WINDOW",
    ESCALATE: "A NAMED HUMAN SIGNS IT IN TELEGRAM",
    DENY: "FORBIDDEN BY ITS OWN CHARTER",
  };

  rows.forEach((r, i) => {
    const y = 270 + i * 130;
    drawText(img, SHORT[r.tool] ?? r.tool.toUpperCase(), PAD, y, 6, INK, 1, 2);
    rightAt(img, money(r.rupees), 700, y, 6, [0x55, 0x52, 0x4b], 1, 2);
    const c = VC[r.verdict];
    rightAt(img, r.verdict, W - PAD, y, 6, c, 1, 2);
    const rid = (r.rule_id || "").toUpperCase();
    const ridW = textWidth(rid, 3, 2);
    capped(img, why[r.verdict], PAD, y + 52, SAFE - ridW - 60, 3, [0x8b, 0x87, 0x7e], 1, 2);
    rightAt(img, rid, W - PAD, y + 52, 3, [0x8b, 0x87, 0x7e], 0.8, 2);
    img.rect(PAD, y + 86, SAFE, 1, INK, 0.12);
  });

  capped(img, "REAL VERDICTS FROM A RECORDED RUN - EACH WITH A LEDGER ENTRY YOU CAN CHECK", PAD, H - PAD - 14, SAFE, 3, [0x8b, 0x87, 0x7e], 1, 2);
  return img.toPNG();
}

/** 03 — tamper evidence. One edited byte breaks everything after it. */
function panelTamper() {
  const img = new Raster(W, H, CARBON);
  dots(img, 26, 0.05, PAPER);
  eyebrow(img, "02", "THE RECORD");
  line(img, "EDIT ONE ENTRY AND EVERY", PAD, 130, 8, PAPER);
  line(img, "ENTRY AFTER IT BREAKS.", PAD, 210, 8, PAPER);

  const bytes = (replay.chain || []).map((e) =>
    parseInt(String(e.entry_hash).replace(/^sha256:/, "").slice(0, 2), 16),
  );
  const n = Math.min(14, bytes.length);
  const bw = 54;
  const gap = 20;
  const x0 = PAD;
  const midY = 470;
  const BROKEN = Math.min(6, n - 2);

  for (let i = 0; i < n; i++) {
    const h = 70 + (bytes[i] / 255) * 190;
    const x = x0 + i * (bw + gap);
    const after = i >= BROKEN; // everything from the edit onward is now wrong
    const col = after ? DENY : PAPER;
    img.rect(x, midY - h / 2, bw, h, col, after ? 0.85 : 0.34);
    img.rect(x, midY - h / 2, bw, 4, col, 1);
    img.rect(x, midY + h / 2 - 4, bw, 4, col, 1);
    if (i === BROKEN) img.rect(x - 5, midY - h / 2 - 14, bw + 10, 4, ACCENT);
  }
  capped(img, "ONE BYTE CHANGED HERE", Math.min(x0 + BROKEN * (bw + gap) - 40, W - PAD - 260), midY - 150, 300, 3, ACCENT, 1, 2);
  line(img, "VERIFIER: FAIL - ENTRY_HASH_MISMATCH", PAD, 640, 5, DENY);
  capped(img, "FOUND BY A VERIFIER THAT SHARES NO CODE WITH THE GATE", PAD, H - PAD - 14, SAFE, 3, DIM, 1, 2);
  return img.toPNG();
}

/** 04 — what an auditor is handed. */
function panelCompliance() {
  const img = new Raster(W, H, PAPER);
  dots(img, 26, 0.05, INK);
  eyebrow(img, "03", "COMPLIANCE", [0x55, 0x52, 0x4b]);
  line(img, "BUILT FOR THE AUDIT,", PAD, 130, 8, INK);
  line(img, "NOT JUST THE DEMO.", PAD, 210, 8, INK);

  const cols = [
    ["SOC 2", ["TSC CC7.2 / CC7.3", "MONITORING AND EVALUATION", "TSC CC8.1", "CHANGE MANAGEMENT"]],
    ["EU AI ACT", ["REG. 2024/1689 ART. 12", "AUTOMATIC LOGGING", "ART. 14", "HUMAN OVERSIGHT"]],
    ["RBI", ["IT GOVERNANCE, 2023", "MAKER-CHECKER / DUAL AUTH", "AUDIT TRAIL", "OVER STRAIGHT-THROUGH PROCESSING"]],
  ];
  const colW = Math.floor(SAFE / 3);
  cols.forEach(([fw, items], i) => {
    const x = PAD + i * colW;
    drawText(img, fw, x, 330, 5, ACCENT, 1, 2);
    img.rect(x, 380, colW - 40, 1, INK, 0.14);
    items.forEach((it, k) => {
      const bold = k % 2 === 0;
      capped(img, it, x, 410 + k * 42, colW - 40, 3, bold ? INK : [0x8b, 0x87, 0x7e], 1, 2);
    });
  });

  // One scale for both, chosen from the longer string: fitting them independently made the pair look
  // like two different sizes of the same note.
  const foot = [
    "ONE EXPORT PER PERIOD: EVERY DECISION, THE RULES IN FORCE, THE APPROVALS, THE MATHS.",
    "CONTROL-LEVEL MAPPING, NOT LEGAL ADVICE - AND IT REPORTS ITS OWN COVERAGE GAPS.",
  ];
  const fs = Math.min(...foot.map((t) => fitScale(t, SAFE, 3, 2)));
  drawText(img, foot[0], PAD, 650, fs, [0x55, 0x52, 0x4b], 1, 2);
  drawText(img, foot[1], PAD, H - PAD - 14, fs, [0x8b, 0x87, 0x7e], 1, 2);
  return img.toPNG();
}

// -------------------------------------------------------------------------------------- write ----
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const set = [
  ["ph-1-claim.png", panelClaim],
  ["ph-2-decision.png", panelDecision],
  ["ph-3-tamper.png", panelTamper],
  ["ph-4-compliance.png", panelCompliance],
];
console.log(`[ph-gallery] ${W}x${H} — Product Hunt's recommended gallery size`);
for (const [name, fn] of set) {
  const p = join(out, name);
  writeFileSync(p, fn());
  console.log(`  ${name.padEnd(22)} ${(statSync(p).size / 1024).toFixed(0)} KB`);
}
console.log(`[ph-gallery] wrote ${set.length} images to ${out}`);
