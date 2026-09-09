/**
 * Perceptual colour ramps, baked into a 256 x 1 RGBA texture for the field
 * shader. Key colours are the standard matplotlib / Google Turbo control
 * points, linearly interpolated in sRGB.
 */

type Stop = [number, number, number, number]; // t, r, g, b (0-255)

const RAMPS: Record<string, Stop[]> = {
  turbo: [
    [0.0, 48, 18, 59], [0.1, 70, 107, 227], [0.2, 62, 155, 254], [0.3, 24, 214, 203],
    [0.4, 70, 248, 131], [0.5, 162, 252, 60], [0.6, 225, 220, 55], [0.7, 253, 165, 49],
    [0.8, 239, 89, 17], [0.9, 196, 37, 2], [1.0, 122, 4, 3],
  ],
  viridis: [
    [0.0, 68, 1, 84], [0.1, 72, 40, 120], [0.2, 62, 74, 137], [0.3, 49, 104, 142],
    [0.4, 38, 130, 142], [0.5, 31, 158, 137], [0.6, 53, 183, 121], [0.7, 109, 205, 89],
    [0.8, 180, 222, 44], [0.9, 226, 228, 24], [1.0, 253, 231, 37],
  ],
  inferno: [
    [0.0, 0, 0, 4], [0.1, 22, 11, 57], [0.2, 66, 10, 104], [0.3, 106, 23, 110],
    [0.4, 147, 38, 103], [0.5, 188, 55, 84], [0.6, 221, 81, 58], [0.7, 243, 120, 25],
    [0.8, 252, 165, 10], [0.9, 246, 215, 70], [1.0, 252, 255, 164],
  ],
  magma: [
    [0.0, 0, 0, 4], [0.2, 44, 17, 95], [0.4, 122, 28, 109], [0.6, 200, 54, 90],
    [0.8, 249, 142, 82], [1.0, 252, 253, 191],
  ],
  plasma: [
    [0.0, 13, 8, 135], [0.15, 84, 2, 163], [0.3, 139, 10, 165], [0.45, 185, 50, 137],
    [0.6, 219, 92, 104], [0.75, 244, 136, 73], [0.9, 253, 195, 40], [1.0, 240, 249, 33],
  ],
  coolwarm: [
    [0.0, 59, 76, 192], [0.25, 122, 157, 236], [0.5, 232, 232, 232],
    [0.75, 238, 143, 116], [1.0, 180, 4, 38],
  ],
  ember: [
    [0.0, 10, 12, 26], [0.25, 52, 33, 92], [0.5, 148, 47, 96],
    [0.75, 237, 118, 60], [1.0, 255, 232, 173],
  ],
  steel: [
    [0.0, 12, 16, 26], [0.3, 33, 62, 94], [0.6, 86, 146, 176],
    [0.85, 178, 213, 224], [1.0, 245, 250, 252],
  ],
};

export const COLORMAP_NAMES = Object.keys(RAMPS);

/** 256 RGBA texels for the named ramp. */
export function rampTexels(name: string): Uint8Array {
  const stops = RAMPS[name] ?? RAMPS.turbo;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[k + 1];
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    out[4 * i] = Math.round(a[1] + (b[1] - a[1]) * f);
    out[4 * i + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
    out[4 * i + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
    out[4 * i + 3] = 255;
  }
  return out;
}

/** CSS colour for a normalised value, used by the HTML legend and charts. */
export function rampCss(name: string, t: number): string {
  const tex = cache(name);
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return `rgb(${tex[4 * i]},${tex[4 * i + 1]},${tex[4 * i + 2]})`;
}

const memo = new Map<string, Uint8Array>();
function cache(name: string): Uint8Array {
  let t = memo.get(name);
  if (!t) { t = rampTexels(name); memo.set(name, t); }
  return t;
}

/** `linear-gradient(...)` string for a legend bar. */
export function rampGradient(name: string, steps = 16): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${rampCss(name, t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
