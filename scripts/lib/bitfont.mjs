/**
 * A 5x7 bitmap font, so the frame renderer can set type without a font rasteriser.
 *
 * Only what the teaser needs: A-Z, 0-9, a handful of punctuation, plus the rupee sign and a tick.
 * Each glyph is seven row-bitmasks, five bits wide, bit 4 = leftmost column. Lowercase input is
 * upcased by the caller — this face has no lowercase, which suits the mono all-caps labels the rest
 * of the brand already uses.
 */
export const GLYPH_W = 5;
export const GLYPH_H = 7;

export const FONT = {
  "A": [14,17,17,31,17,17,17],
  "B": [30,17,17,30,17,17,30],
  "C": [14,17,16,16,16,17,14],
  "D": [30,17,17,17,17,17,30],
  "E": [31,16,16,30,16,16,31],
  "F": [31,16,16,30,16,16,16],
  "G": [14,17,16,23,17,17,14],
  "H": [17,17,17,31,17,17,17],
  "I": [31,4,4,4,4,4,31],
  "J": [7,2,2,2,2,18,12],
  "K": [17,18,20,24,20,18,17],
  "L": [16,16,16,16,16,16,31],
  "M": [17,27,21,21,17,17,17],
  "N": [17,25,21,19,17,17,17],
  "O": [14,17,17,17,17,17,14],
  "P": [30,17,17,30,16,16,16],
  "Q": [14,17,17,17,21,18,13],
  "R": [30,17,17,30,20,18,17],
  "S": [15,16,16,14,1,1,30],
  "T": [31,4,4,4,4,4,4],
  "U": [17,17,17,17,17,17,14],
  "V": [17,17,17,17,17,10,4],
  "W": [17,17,17,21,21,27,17],
  "X": [17,17,10,4,10,17,17],
  "Y": [17,17,10,4,4,4,4],
  "Z": [31,1,2,4,8,16,31],
  "0": [14,17,19,21,25,17,14],
  "1": [4,12,4,4,4,4,14],
  "2": [14,17,1,2,4,8,31],
  "3": [31,2,4,2,1,17,14],
  "4": [2,6,10,18,31,2,2],
  "5": [31,16,30,1,1,17,14],
  "6": [6,8,16,30,17,17,14],
  "7": [31,1,2,4,8,8,8],
  "8": [14,17,17,14,17,17,14],
  "9": [14,17,17,15,1,2,12],
  " ": [0,0,0,0,0,0,0],
  ".": [0,0,0,0,0,12,12],
  ",": [0,0,0,0,12,12,8],
  ":": [0,12,12,0,12,12,0],
  "_": [0,0,0,0,0,0,31],
  "-": [0,0,0,31,0,0,0],
  "/": [1,2,2,4,8,8,16],
  "?": [14,17,1,6,4,0,4],
  "!": [4,4,4,4,4,0,4],
  "\"": [4,4,0,0,0,0,0],
  "'": [4,4,0,0,0,0,0],
  "(": [2,4,8,8,8,4,2],
  ")": [8,4,2,2,2,4,8],
  "+": [0,4,4,31,4,4,0],
  "=": [0,0,31,0,31,0,0],
  "#": [10,10,31,10,31,10,10],
  "\u20b9": [15,20,30,20,15,2,4],
  "\u2713": [0,1,2,4,20,8,0],
  "\u00b7": [0,0,0,12,12,0,0],
};

/**
 * The largest scale at or below `maxScale` that keeps `text` inside `maxW`. Text overflowing the
 * frame is the failure mode this face invites — every glyph is a fixed 5 columns, so a long line
 * grows linearly and silently runs off the edge.
 */
export function fitScale(text, maxW, maxScale, tracking = 1) {
  for (let s = maxScale; s > 1; s--) if (textWidth(text, s, tracking) <= maxW) return s;
  return 1;
}

/** Width in pixels of `text` at the given scale and letter spacing. */
export function textWidth(text, scale, tracking = 1) {
  const n = [...text].length;
  return n * GLYPH_W * scale + Math.max(0, n - 1) * tracking * scale;
}

/**
 * Draw `text` with its top-left at (x, y). Every glyph pixel becomes a scale x scale block, which is
 * what gives the type its deliberately coarse, plotted look rather than a bad imitation of a real face.
 */
export function drawText(img, text, x, y, scale, rgb, a = 1, tracking = 1) {
  let cx = x;
  for (const raw of [...text]) {
    const ch = raw.toUpperCase();
    const g = FONT[ch] ?? FONT["?"];
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = g[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (1 << (GLYPH_W - 1 - col))) {
          img.rect(cx + col * scale, y + row * scale, scale, scale, rgb, a);
        }
      }
    }
    cx += (GLYPH_W + tracking) * scale;
  }
  return cx - tracking * scale;
}
