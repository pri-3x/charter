/**
 * The social card and the app icon, drawn from the same geometry as the product.
 *
 * Deliberately wordless. Rendering type into a raster needs a font rasteriser, and shipping one to
 * put "Charter" on a card is not worth it — the title and description come from the meta tags, which
 * is what every platform renders beside the image anyway. What the image carries instead is the
 * mark (the keyhole) and the chain motif from the artefacts panel, so the card is recognisably this
 * product rather than a stock gradient.
 */
import { Raster } from "./png.mjs";

const CARBON = [0x23, 0x23, 0x23];
const PAPER = [0xf2, 0xf0, 0xea];
const ACCENT = [0xff, 0x5c, 0x1a];

/**
 * The Charter mark: a keyhole cut OUT of a solid tile, with the gate barred across the opening.
 *
 * The void is not a stylistic choice. Drawn as a solid positive shape — a light bowl and skirt on a
 * dark field — the same geometry reads unmistakably as a chess pawn wearing a belt. A keyhole is
 * legible only as an aperture, so the tile is the surface and the keyhole is the hole punched
 * through it. `hole` is the colour showing through, i.e. whatever the tile is sitting on.
 *
 * Authored in a 32-unit box so the numbers match the inline SVG in the pages. Change one, change both.
 */
function mark(img, cx, cy, size, hole) {
  const s = size / 32;
  const X = (u) => cx + (u - 16) * s;
  const Y = (v) => cy + (v - 16) * s;

  img.roundRect(X(2), Y(2), 28 * s, 28 * s, 7 * s, PAPER);

  // the aperture: bowl + flared skirt, in the background colour
  img.disc(X(16), Y(13.5), 4.6 * s, hole);
  img.poly(
    [
      [X(13.7), Y(17.5)],
      [X(18.3), Y(17.5)],
      [X(20), Y(25)],
      [X(12), Y(25)],
    ],
    hole,
  );

  // The gate: wider than the passage on both sides, so it reads as barring the opening rather than
  // sitting inside it.
  img.capsule(X(10.4), Y(19.4), 11.2 * s, 2.9 * s, ACCENT);
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

  mark(img, 250, H / 2, 300, CARBON);
  chain(img, 470, H / 2, 640, 300, seedBytes);

  // Accent rule along the bottom, the width of the mark — a signature stroke, not a progress bar.
  img.rect(118, H - 74, 264, 4, ACCENT, 1);
  return img.toPNG();
}

/** 512x512 maskable-ish app icon: the mark on carbon, generous padding. */
export function appIcon() {
  const S = 512;
  const img = new Raster(S, S, CARBON);
  dots(img, 32, 0.05);
  mark(img, S / 2, S / 2, 320, CARBON);
  return img.toPNG();
}
