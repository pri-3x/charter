/**
 * Build the teaser video: `node scripts/make-teaser.mjs` → dist-web/teaser.mp4
 *
 * Frames are drawn with the same Raster primitives that produce the OG card, so the video is in the
 * product's own geometry rather than a template. Raw RGB is piped straight into ffmpeg — there is no
 * per-frame PNG encode, which is the difference between this taking seconds and taking minutes.
 *
 * The verdicts, rule ids and entry hashes come from packages/console/public/replay.json, i.e. a real
 * recorded run against a live gate. Nothing in the ledger sequence is invented; to change what is on
 * screen, re-record with scripts/record-replay.mjs rather than editing this file.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { Raster } from "./lib/png.mjs";
import { drawText, textWidth, fitScale } from "./lib/bitfont.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(root, "dist-web");

const W = 1080;
const H = 1080;
const FPS = 30;
const DUR = 15.5;

const CARBON = [0x23, 0x23, 0x23];
const PAPER = [0xf2, 0xf0, 0xea];
const ACCENT = [0xff, 0x5c, 0x1a];
const ALLOW = [0x8e, 0xc0, 0x63];
const DENY = [0xef, 0x6a, 0x4c];
const HOLD = [0xf0, 0xab, 0x2e];
const DIM = [0x8b, 0x87, 0x7e];

// ---------------------------------------------------------------------------------- real data ----
const replay = JSON.parse(readFileSync(join(root, "packages/console/public/replay.json"), "utf8"));
const VERDICT_COLOUR = { ALLOW, DENY, ESCALATE: HOLD };
const SHORT = {
  refund: "REFUND",
  send_email: "EMAIL",
  initiate_payout: "PAYOUT",
  lookup_order: "LOOKUP",
  delete_record: "DELETE",
};

/** The four recorded rows that carry the story, in the order they happened. */
const ROWS = (() => {
  const pick = (tool, verdict) => replay.rows.find((r) => r.tool === tool && r.verdict === verdict);
  return [
    pick("refund", "ALLOW"),
    pick("send_email", "ALLOW"),
    pick("refund", "ESCALATE"),
    pick("initiate_payout", "DENY"),
  ].filter(Boolean);
})();

const money = (r) => (r > 0 ? "₹" + r.toLocaleString("en-IN") : "-");

// ------------------------------------------------------------------------------------ helpers ----
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Smoothstep, so entrances do not look linear. */
const ease = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** 0 → 1 across the window [a, b] in seconds. */
const at = (t, a, b) => ease((t - a) / (b - a));

const SAFE = W - 140; // social crops nibble the edges; keep type inside this

/**
 * Centre `text`, shrinking it if it would not fit the safe width. `scale` is a maximum, not a
 * promise — an earlier cut had the second headline running off both edges of the frame.
 */
function centred(img, text, y, scale, rgb, a = 1, tracking = 1) {
  const s = fitScale(text, SAFE, scale, tracking);
  const w = textWidth(text, s, tracking);
  drawText(img, text, Math.round((W - w) / 2), y, s, rgb, a, tracking);
  return s;
}

/** Right-align, so a value cannot grow rightwards into whatever sits beside it. */
function rightAt(img, text, xRight, y, scale, rgb, a = 1, tracking = 1) {
  drawText(img, text, Math.round(xRight - textWidth(text, scale, tracking)), y, scale, rgb, a, tracking);
}

/** The keyhole mark, same 32-unit coordinates as the site and the OG card. */
function mark(img, cx, cy, size, a = 1) {
  const s = size / 32;
  const X = (u) => cx + (u - 16) * s;
  const Y = (v) => cy + (v - 16) * s;
  img.roundRect(X(2), Y(2), 28 * s, 28 * s, 7 * s, PAPER, a);
  img.disc(X(16), Y(13.5), 4.6 * s, CARBON, a);
  img.poly([[X(13.7), Y(17.5)], [X(18.3), Y(17.5)], [X(20), Y(25)], [X(12), Y(25)]], CARBON, a);
  img.capsule(X(10.4), Y(19.4), 11.2 * s, 2.9 * s, ACCENT, a);
}

/** The faint dot grid from the carbon panels. */
function dots(img, step = 30, a = 0.05) {
  for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) img.blend(x, y, PAPER, a);
}

// ------------------------------------------------------------------------------------- scenes ----
function sceneOpen(img, t) {
  const m = at(t, 0.15, 1.0);
  if (m > 0) mark(img, W / 2, 300, 170 * (0.9 + 0.1 * m), m);

  const nm = at(t, 0.7, 1.35);
  if (nm > 0) centred(img, "CHARTER", 430, 11, PAPER, nm, 3);

  const tg = at(t, 1.0, 1.7);
  if (tg > 0) centred(img, "RUNTIME AUTHORITY FOR AI AGENTS", 545, 4, DIM, tg * 0.9, 2);

  const l1 = at(t, 1.8, 2.5);
  if (l1 > 0) centred(img, "YOUR AI CAN SPEND MONEY.", 680, 6, PAPER, l1, 2);

  const l2 = at(t, 2.3, 3.0);
  if (l2 > 0) {
    const s2 = centred(img, "CHARTER DECIDES WHEN IT CAN.", 765, 6, PAPER, l2, 2);
    const uw = textWidth("CHARTER DECIDES WHEN IT CAN.", s2, 2);
    img.rect((W - uw) / 2, 765 + 7 * s2 + 18, uw * l2, 5, ACCENT, l2);
  }
}

function sceneLedger(img, t) {
  const head = at(t, 3.3, 3.8);
  if (head > 0) {
    drawText(img, "EVERY ACTION ASKS FIRST", 90, 160, 4, DIM, head * 0.9, 2);
    img.rect(90, 212, (W - 180) * head, 2, PAPER, 0.18);
  }

  ROWS.forEach((row, i) => {
    const start = 3.9 + i * 1.2;
    const a = at(t, start, start + 0.42);
    if (a <= 0) return;
    const y = 280 + i * 150;
    const slide = (1 - a) * 26;

    drawText(img, SHORT[row.tool] ?? row.tool.toUpperCase(), 90 + slide, y, 5, PAPER, a, 2);
    // Right edge at 600, not 700: the longest amount (₹80,000) and the longest verdict
      // (ESCALATE) left only ~18px between them, which reads as one run of characters.
      rightAt(img, money(row.rupees), 600 + slide, y, 5, DIM, a, 2);

    // The verdict lands a beat after the request, so you watch it being decided.
    const vd = at(t, start + 0.34, start + 0.62);
    if (vd > 0) {
      const c = VERDICT_COLOUR[row.verdict];
      const lw = textWidth(row.verdict, 5, 2);
      drawText(img, row.verdict, W - 90 - lw, y, 5, c, vd, 2);
      img.rect(90, y + 54, (W - 180) * vd, 2, c, vd * 0.4);
      const rid = (row.rule_id || "").toUpperCase();
      if (rid) drawText(img, rid, 90, y + 70, 3, DIM, vd * 0.75, 2);
    }

    // The escalation is a two-part story: frozen, then signed by a person.
    if (row.verdict === "ESCALATE") {
      const ap = at(t, start + 0.85, start + 1.15);
      if (ap > 0) drawText(img, "FINANCE-LEAD APPROVED. NAME ON THE RECORD.", 90, y + 100, 3, HOLD, ap, 2);
    }
  });
}

function sceneTamper(img, t) {
  const head = at(t, 9.7, 10.2);
  if (head > 0) centred(img, "NOW TRY TO EDIT THE RECORD", 160, 5, PAPER, head, 2);

  // One bar per real ledger entry, heights taken from the entry hashes.
  const bytes = (replay.chain || []).map((e) =>
    parseInt(String(e.entry_hash).replace(/^sha256:/, "").slice(0, 2), 16),
  );
  const n = Math.min(18, bytes.length);
  const bw = 38;
  const gap = 12;
  const total = n * bw + (n - 1) * gap;
  const x0 = (W - total) / 2;
  const midY = 520;
  const BROKEN = Math.min(11, n - 2);

  const build = at(t, 10.1, 11.0);
  for (let i = 0; i < n; i++) {
    if (i / n > build) break;
    const h = 90 + (bytes[i] / 255) * 260;
    const x = x0 + i * (bw + gap);
    const brk = at(t, 11.4, 11.8);
    const broken = brk > 0 && i === BROKEN;
    const col = broken ? DENY : PAPER;
    img.rect(x, midY - h / 2, bw, h, col, broken ? 1 : 0.42);
    img.rect(x, midY - h / 2, bw, 4, col, broken ? 1 : 0.8);
    img.rect(x, midY + h / 2 - 4, bw, 4, col, broken ? 1 : 0.8);
    // the edited entry visibly steps out of line with its neighbours
    if (broken) img.rect(x - 4, midY - h / 2 - 12 * brk, bw + 8, 4, DENY, brk);
  }

  const edit = at(t, 11.3, 11.7);
  if (edit > 0) centred(img, "ONE BYTE CHANGED", 710, 4, DENY, edit, 2);

  const fail = at(t, 11.9, 12.3);
  if (fail > 0) {
    centred(img, "VERIFIER: FAIL", 790, 7, DENY, fail, 2);
    centred(img, "ENTRY_HASH_MISMATCH", 875, 4, DIM, fail * 0.9, 2);
  }
  const ind = at(t, 12.4, 12.8);
  if (ind > 0) centred(img, "FOUND BY A VERIFIER THAT SHARES NO CODE", 940, 3, DIM, ind * 0.85, 2);
}

function sceneClose(img, t) {
  const a = at(t, 13.3, 13.9);
  if (a > 0) centred(img, "NOTHING GETS PAST IT", 400, 8, PAPER, a, 2);
  const b = at(t, 13.6, 14.2);
  if (b > 0) centred(img, "UNRECORDED.", 495, 8, ACCENT, b, 2);
  const m = at(t, 14.0, 14.5);
  if (m > 0) mark(img, W / 2, 700, 150, m);
  const d = at(t, 14.3, 14.8);
  if (d > 0) centred(img, "USECHARTER.XYZ", 830, 5, PAPER, d, 3);
}

function renderFrame(t) {
  const img = new Raster(W, H, CARBON);
  dots(img);
  if (t < 3.25) sceneOpen(img, t);
  else if (t < 9.65) sceneLedger(img, t);
  else if (t < 13.25) sceneTamper(img, t);
  else sceneClose(img, t);
  return img.px;
}

// -------------------------------------------------------------------------------------- encode ----
if (!ROWS.length) {
  console.error("[teaser] replay.json has no usable rows — run scripts/record-replay.mjs first.");
  process.exit(1);
}
if (!existsSync(out)) mkdirSync(out, { recursive: true });

const frames = Math.round(DUR * FPS);
const dest = join(out, "teaser.mp4");
console.log(`[teaser] ${W}x${H} · ${FPS}fps · ${DUR}s · ${frames} frames`);
console.log(`[teaser] rows from replay.json: ${ROWS.map((r) => r.tool + ":" + r.verdict).join(", ")}`);

const ff = spawn(
  ffmpegPath,
  [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    // yuv420p is what every social player needs; faststart moves the moov atom to the front so
    // playback can begin before the whole file has arrived.
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "20",
    "-movflags", "+faststart",
    dest,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);

for (let f = 0; f < frames; f++) {
  const buf = renderFrame(f / FPS);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if ((f + 1) % 90 === 0) console.log(`  ${f + 1}/${frames}`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exited " + c)))));

console.log(`[teaser] wrote ${dest} (${(statSync(dest).size / 1048576).toFixed(2)} MB)`);
