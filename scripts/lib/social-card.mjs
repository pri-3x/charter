/**
 * The social card and the app icon, drawn from the same geometry as the product.
 *
 * Deliberately wordless. Rendering type into a raster needs a font rasteriser, and shipping one to
 * put "Charter" on a card is not worth it — the title and description come from the meta tags, which
 * is what every platform renders beside the image anyway. What the image carries instead is the
 * mark (the open seal) and the chain motif from the artefacts panel, so the card is recognisably
 * this product rather than a stock gradient.
 */
import { Raster } from "./png.mjs";

const CARBON = [0x23, 0x23, 0x23];
const PAPER = [0xf2, 0xf0, 0xea];
const ACCENT = [0xff, 0x5c, 0x1a];

/** The open seal: two rings with a gap in the upper right, plus the accent tick. */
function seal(img, cx, cy, r, stroke) {
  // Gap centred on -45°, 40° wide, matching the dasharray in the inline SVG mark.
  const GAP_FROM = -Math.PI / 3.4;
  const GAP_TO = -Math.PI / 12;
  img.ring(cx, cy, r, stroke, PAPER, 1, GAP_TO, GAP_FROM + Math.PI * 2);
  img.ring(cx, cy, r * 0.595, stroke * 0.62, PAPER, 0.42);
  const s = r / 9.25; // the mark is authored in a 24-unit box with r = 9.25
  img.line(cx - 3 * s, cy + 0.2 * s, cx - 0.6 * s, cy + 2.6 * s, stroke * 1.35, ACCENT);
  img.line(cx - 0.6 * s, cy + 2.6 * s, cx + 4.2 * s, cy - 2.6 * s, stroke * 1.35, ACCENT);
}

/** A faint dot grid, the same texture as the carbon panels on the page. */
function dots(img, step, a) {
  for (let y = step; y < img.h; y += step)
    for (let x = step; x < img.w; x += step) img.blend(x, y, PAPER, a);
}

/**
 * The chain: one block per verdict, block height driven by bytes so the silhouette is not uniform.
 * Bytes are passed in rather than random so the card is reproducible for a given input.
 */
function chain(img, x0, yMid, w, maxH, bytes) {
  const n = 14;
  const bw = Math.floor(w / n);
  for (let k = 0; k < n; k++) {
    const b = bytes[k % bytes.length] / 255;
    const h = maxH * (0.28 + b * 0.72);
    const x = x0 + k * bw;
    const bwi = bw - Math.max(3, Math.round(bw * 0.22));
    img.rect(x, yMid - h / 2, bwi, h, PAPER, 0.16);
    img.rect(x, yMid - h / 2, bwi, 2, PAPER, 0.7);
    img.rect(x, yMid + h / 2 - 2, bwi, 2, PAPER, 0.7);
    if (k) img.rect(x - (bw - bwi), yMid - 1, bw - bwi, 2, PAPER, 0.34);
  }
}

/** 1200x630 Open Graph / Twitter card. */
export function socialCard(seedBytes) {
  const W = 1200;
  const H = 630;
  const img = new Raster(W, H, CARBON);
  dots(img, 24, 0.05);

  seal(img, 250, H / 2, 132, 13);
  chain(img, 470, H / 2, 640, 300, seedBytes);

  // Accent rule along the bottom, the width of the seal — a signature stroke, not a progress bar.
  img.rect(118, H - 74, 264, 4, ACCENT, 1);
  return img.toPNG();
}

/** 512x512 maskable-ish app icon: the mark on carbon, generous padding. */
export function appIcon() {
  const S = 512;
  const img = new Raster(S, S, CARBON);
  dots(img, 32, 0.05);
  seal(img, S / 2, S / 2, 150, 15);
  return img.toPNG();
}
