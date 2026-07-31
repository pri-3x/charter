/**
 * A minimal PNG encoder, so the build can emit a real raster social card with no dependencies.
 *
 * Only what is needed: 8-bit RGB, no interlacing, filter type 0 on every scanline. zlib comes from
 * node:zlib; the CRC-32 the format requires per chunk is the one thing that has to be written out.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A mutable RGB canvas with just the primitives the card needs. */
export class Raster {
  constructor(w, h, bg = [0, 0, 0]) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0];
      this.px[i * 3 + 1] = bg[1];
      this.px[i * 3 + 2] = bg[2];
    }
  }

  /** Source-over blend of one pixel. Alpha 0..1; out of bounds is a no-op. */
  blend(x, y, rgb, a = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) {
      this.px[i] = rgb[0];
      this.px[i + 1] = rgb[1];
      this.px[i + 2] = rgb[2];
      return;
    }
    this.px[i] = this.px[i] * (1 - a) + rgb[0] * a;
    this.px[i + 1] = this.px[i + 1] * (1 - a) + rgb[1] * a;
    this.px[i + 2] = this.px[i + 2] * (1 - a) + rgb[2] * a;
  }

  rect(x, y, w, h, rgb, a = 1) {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++)
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) this.blend(xx, yy, rgb, a);
  }

  /**
   * Anti-aliased ring. `from`/`to` are radians; a partial sweep is how the mark's open seal is drawn.
   * Coverage comes from the distance to the ideal radius, which is what keeps the edge smooth.
   */
  ring(cx, cy, r, width, rgb, a = 1, from = 0, to = Math.PI * 2) {
    const outer = r + width / 2 + 1;
    for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        const edge = Math.abs(d - r);
        if (edge > width / 2 + 0.75) continue;
        let ang = Math.atan2(dy, dx);
        if (ang < 0) ang += Math.PI * 2;
        let lo = from;
        let hi = to;
        if (lo < 0) lo += Math.PI * 2;
        if (hi < 0) hi += Math.PI * 2;
        const inSweep = lo <= hi ? ang >= lo && ang <= hi : ang >= lo || ang <= hi;
        if (!inSweep) continue;
        const cov = Math.min(1, Math.max(0, width / 2 + 0.5 - edge));
        this.blend(x, y, rgb, a * cov);
      }
    }
  }

  /** Anti-aliased thick line, used for the tick. */
  line(x0, y0, x1, y1, width, rgb, a = 1) {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const rad = width / 2;
      for (let y = Math.floor(cy - rad - 1); y <= Math.ceil(cy + rad + 1); y++) {
        for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x++) {
          const d = Math.hypot(x - cx, y - cy);
          const cov = Math.min(1, Math.max(0, rad + 0.5 - d));
          if (cov > 0) this.blend(x, y, rgb, a * cov);
        }
      }
    }
  }

  toPNG() {
    const stride = this.w * 3;
    const raw = Buffer.alloc((stride + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (stride + 1)] = 0; // filter: none
      this.px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}
