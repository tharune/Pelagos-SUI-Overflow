/**
 * Shared curve smoothing — the single source of truth for every chart line in
 * the app (distribution curves, hero terminal, basket sparklines).
 *
 * Uses monotone cubic Hermite interpolation (Fritsch–Carlson). Unlike a
 * cardinal / Catmull-Rom spline it provably never overshoots between points:
 * peaks round off cleanly and flats stay flat, so the line reads as a smooth
 * distribution instead of bowing past each value (the "rocky" wobble a cardinal
 * spline introduces on uneven data). Every surface inherits the same line.
 */

export type Pt = { x: number; y: number };

function toPts(input: Pt[] | Array<[number, number]>): Pt[] {
  return input.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
}

/** Monotone tangents for each point given strictly-increasing xs. */
export function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i] || 1e-6;
    dx.push(h);
    slope.push((ys[i + 1] - ys[i]) / h);
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      // local extremum → flat tangent kills the overshoot that reads as rocky
      m[i] = 0;
    } else {
      // weighted harmonic mean of the neighbouring secants
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  return m;
}

/** Monotone curve as an SVG path `d` string. Accepts {x,y}[] or [x,y][]. */
export function monotonePath(input: Pt[] | Array<[number, number]>): string {
  const pts = toPts(input);
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  if (n === 2) {
    return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const m = monotoneTangents(xs, ys);
  const d = [`M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    const c1x = xs[i] + h / 3;
    const c1y = ys[i] + (m[i] * h) / 3;
    const c2x = xs[i + 1] - h / 3;
    const c2y = ys[i + 1] - (m[i + 1] * h) / 3;
    d.push(`C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${xs[i + 1].toFixed(1)} ${ys[i + 1].toFixed(1)}`);
  }
  return d.join(" ");
}

/**
 * Trace the monotone curve into a canvas path. The caller owns beginPath() and
 * any fill/stroke; this issues a moveTo to the first point followed by the
 * bezier segments, ending exactly on the last point.
 */
export function traceMonotone(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  const n = pts.length;
  if (n === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const m = monotoneTangents(xs, ys);
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    ctx.bezierCurveTo(
      xs[i] + h / 3,
      ys[i] + (m[i] * h) / 3,
      xs[i + 1] - h / 3,
      ys[i + 1] - (m[i + 1] * h) / 3,
      xs[i + 1],
      ys[i + 1],
    );
  }
}
