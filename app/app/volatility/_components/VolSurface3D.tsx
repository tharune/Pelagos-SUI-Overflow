"use client";

// ---------------------------------------------------------------------------
// Interactive 3D implied-vol surface (three.js), Bloomberg-OVDV style.
//
//   x = log-moneyness (strike)   ·   z = tenor   ·   y = implied vol
//
// Built from the LIVE SVI surface (VolDeskSurface.slices). Two things make it
// read as a real desk tool rather than a UI artifact:
//
//  1. Robust IV scaling. The front (minute-tenor) oracle's IV is microstructure
//     noise that spikes to absurd levels; left raw it dominates the height AND
//     the colour range, flattening everything else into one blue blob. We
//     winsorize the IV grid to a robust [p5, p92] band for BOTH height and
//     colour, so the spike clips to a plateau and the rest of the surface gets
//     the full colour gradient — the smile and term structure become legible.
//
//  2. HTML-overlay axis labels projected from 3D anchors each frame, NOT 3D
//     sprites. Sprites collided when projected (the overlapping "MONEYNESS/+7%"
//     mess); projected HTML gives crisp, DPI-perfect, non-overlapping ticks that
//     track the surface as you orbit.
// ---------------------------------------------------------------------------

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VolDeskSurface } from "../../_lib/predict-strip-client";
import { C } from "../../_lib/tokens";

// Sequential heat ramp (deep blue → cyan → green → amber → red). Maximises
// level-to-level separation so you can read the IV gradient at a glance — the
// thing a vol surface is for.
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [0x10, 0x2a, 0x5e]],
  [0.18, [0x1f, 0x5c, 0xc4]],
  [0.38, [0x27, 0x9c, 0xd8]],
  [0.55, [0x36, 0xc9, 0xb8]],
  [0.7, [0x86, 0xd6, 0x6a]],
  [0.84, [0xf2, 0xc1, 0x49]],
  [0.93, [0xf2, 0x8c, 0x33]],
  [1.0, [0xe5, 0x46, 0x2e]],
];
function ivColor(t: number): THREE.Color {
  const c = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [a, ca] = RAMP[i];
    const [b, cb] = RAMP[i + 1];
    if (c <= b) {
      const f = (c - a) / (b - a || 1);
      return new THREE.Color(
        (ca[0] + (cb[0] - ca[0]) * f) / 255,
        (ca[1] + (cb[1] - ca[1]) * f) / 255,
        (ca[2] + (cb[2] - ca[2]) * f) / 255,
      );
    }
  }
  const l = RAMP[RAMP.length - 1][1];
  return new THREE.Color(l[0] / 255, l[1] / 255, l[2] / 255);
}
function rampCss(t: number): string {
  const c = ivColor(t);
  return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface VolSurface3DProps {
  surface: VolDeskSurface;
  selectedSlice?: number;
  height?: number;
}

type Lbl = { el: HTMLDivElement; anchor: THREE.Vector3; priority: number };

export default function VolSurface3D({ surface, selectedSlice = 0, height = 380 }: VolSurface3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<{ setSlice: (i: number) => void } | null>(null);
  const [failed, setFailed] = React.useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    const labelLayer = labelRef.current;
    if (!mount || !labelLayer) return;

    const slices = (surface.slices ?? []).filter((s) => s.points && s.points.length >= 2);
    if (slices.length === 0) return;

    // ---- shared log-moneyness grid (intersection range, uniform columns) ----
    let kLo = -Infinity, kHi = Infinity;
    for (const s of slices) {
      kLo = Math.max(kLo, s.points[0].log_moneyness);
      kHi = Math.min(kHi, s.points[s.points.length - 1].log_moneyness);
    }
    if (!(kHi > kLo)) {
      kLo = Infinity; kHi = -Infinity;
      for (const s of slices) for (const p of s.points) { kLo = Math.min(kLo, p.log_moneyness); kHi = Math.max(kHi, p.log_moneyness); }
    }
    if (!(kHi > kLo)) return;
    const NCOL = 44;
    const cols: number[] = [];
    for (let i = 0; i < NCOL; i++) cols.push(kLo + ((kHi - kLo) * i) / (NCOL - 1));
    const rows = slices.length;

    const sampleIv = (s: VolDeskSurface["slices"][number], k: number): number => {
      const pts = s.points;
      if (k <= pts[0].log_moneyness) return pts[0].iv;
      if (k >= pts[pts.length - 1].log_moneyness) return pts[pts.length - 1].iv;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (k >= a.log_moneyness && k <= b.log_moneyness) {
          const f = (k - a.log_moneyness) / (b.log_moneyness - a.log_moneyness || 1);
          return a.iv + (b.iv - a.iv) * f;
        }
      }
      return s.atm_iv;
    };

    const grid: number[][] = [];
    const all: number[] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let cI = 0; cI < cols.length; cI++) { const v = sampleIv(slices[r], cols[cI]); row.push(v); all.push(v); }
      grid.push(row);
    }
    // Smooth the IV grid: the short-tenor rows are microstructure-noisy, so a
    // light separable blur (heavier along the noisy tenor axis) turns the jagged
    // ridges into continuous relief without erasing the smile / term structure.
    const blurRows = (g: number[][], k: number) => g.map((row, r) =>
      row.map((_, c) => (g[Math.max(0, r - 1)][c] + k * g[r][c] + g[Math.min(g.length - 1, r + 1)][c]) / (k + 2)));
    const blurCols = (g: number[][], k: number) => g.map((row, r) =>
      row.map((_, c) => (g[r][Math.max(0, c - 1)] + k * g[r][c] + g[r][Math.min(row.length - 1, c + 1)]) / (k + 2)));
    let sgrid = blurRows(grid, 1.1);
    sgrid = blurRows(sgrid, 1.6);
    sgrid = blurRows(sgrid, 2.4);
    sgrid = blurCols(sgrid, 2.0);
    sgrid = blurCols(sgrid, 2.6);

    // Robust scale from the SMOOTHED values + SOFT compression: linear inside
    // [p4, p90], a gentle tanh roll-off above so any residual spike is a soft bump,
    // not a clamped plateau with a cliff. Colour saturates at the top (normC).
    const flat = sgrid.flat().sort((a, b) => a - b);
    let ivLo = quantile(flat, 0.04);
    let ivHi = quantile(flat, 0.93);
    if (!(ivHi > ivLo)) { ivLo = flat[0]; ivHi = Math.max(flat[flat.length - 1], ivLo + 0.01); }
    const norm = (v: number) => {
      const r = (v - ivLo) / (ivHi - ivLo);
      return r <= 0 ? 0 : r <= 1 ? r : 1 + 0.16 * Math.tanh((r - 1) * 1.1);
    };
    const normC = (v: number) => Math.min(1, norm(v));

    // ---- world layout ------------------------------------------------------
    const SX = 5.7;   // moneyness half-width (balanced footprint, never clips the card)
    const SY = 5.4;   // tenor depth
    const SZ = 2.45;  // IV height
    const xAt = (cI: number) => -SX + (cI / (cols.length - 1)) * 2 * SX;
    const yAt = (r: number) => (rows === 1 ? 0 : -SY / 2 + (r / (rows - 1)) * SY);
    const zAt = (v: number) => norm(v) * SZ;

    // ---- scene -------------------------------------------------------------
    const scene = new THREE.Scene();
    const width = mount.clientWidth || 640;
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(-4, 10, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(6, 4, -6);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;
    controls.enablePan = false;
    controls.minPolarAngle = Math.PI * 0.18;
    controls.maxPolarAngle = Math.PI * 0.46;

    // ---- surface mesh ------------------------------------------------------
    // Upsample the tenor axis so the mesh reads smooth between the few raw slices
    // (yAtM(r*UP) === yAt(r), so the tenor labels stay aligned to the fine mesh).
    const UP = rows >= 14 ? 2 : rows >= 6 ? 3 : 4;
    const MROWS = rows <= 1 ? 1 : (rows - 1) * UP + 1;
    const yAtM = (fr: number) => (MROWS === 1 ? 0 : -SY / 2 + (fr / (MROWS - 1)) * SY);
    const ivFine = (fr: number, c: number) => {
      const t = MROWS === 1 ? 0 : fr / UP;
      const r0 = Math.floor(t), r1 = Math.min(rows - 1, r0 + 1), f = t - r0;
      // smoothstep across the tenor gap: rounds the linear facets between raw
      // slices into one continuous slope (kills the "wall" at the short→long
      // term-structure drop). fs(0)=0, fs(1)=1, so the raw rows stay on the mesh.
      const fs = f * f * (3 - 2 * f);
      return sgrid[r0][c] * (1 - fs) + sgrid[r1][c] * fs;
    };
    const vert: THREE.Vector3[] = [];
    const vcol: THREE.Color[] = [];
    for (let fr = 0; fr < MROWS; fr++) for (let c = 0; c < cols.length; c++) {
      const v = ivFine(fr, c);
      vert.push(new THREE.Vector3(xAt(c), zAt(v), yAtM(fr)));
      vcol.push(ivColor(normC(v)));
    }
    const idx = (r: number, c: number) => r * cols.length + c;
    const indices: number[] = [];
    for (let r = 0; r < MROWS - 1; r++) for (let c = 0; c < cols.length - 1; c++) {
      const a = idx(r, c), b = idx(r, c + 1), d = idx(r + 1, c), e = idx(r + 1, c + 1);
      indices.push(a, d, b, b, d, e);
    }
    const positions: number[] = [];
    const colors: number[] = [];
    for (const v of vert) positions.push(v.x, v.y, v.z);
    for (const c of vcol) colors.push(c.r, c.g, c.b);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const surfaceMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.62, metalness: 0.04, flatShading: false,
    }));
    scene.add(surfaceMesh);

    // ---- ATM ridge (log-moneyness 0) + selected-tenor ribbon ---------------
    let atmCol = 0, best = Infinity;
    for (let c = 0; c < cols.length; c++) { const d = Math.abs(cols[c]); if (d < best) { best = d; atmCol = c; } }
    const atmPts: THREE.Vector3[] = [];
    for (let r = 0; r < rows; r++) atmPts.push(new THREE.Vector3(xAt(atmCol), zAt(sgrid[r][atmCol]) + 0.03, yAt(r)));
    const atmLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(atmPts),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.22, gapSize: 0.16, transparent: true, opacity: 0.45 }),
    );
    atmLine.computeLineDistances();
    scene.add(atmLine);

    const ribbonMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0xffffff) });
    let ribbon: THREE.Line | null = null;
    const buildRibbon = (r: number) => {
      if (ribbon) { scene.remove(ribbon); ribbon.geometry.dispose(); }
      const rr = Math.max(0, Math.min(rows - 1, r));
      const pts: THREE.Vector3[] = [];
      for (let c = 0; c < cols.length; c++) pts.push(new THREE.Vector3(xAt(c), zAt(sgrid[rr][c]) + 0.05, yAt(rr)));
      ribbon = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ribbonMat);
      scene.add(ribbon);
    };
    buildRibbon(selectedSlice);
    highlightRef.current = { setSlice: buildRibbon };

    // ---- floor grid --------------------------------------------------------
    const grp = new THREE.Group();
    const gridMat = new THREE.LineBasicMaterial({ color: 0x16273c, transparent: true, opacity: 0.5 });
    const cStep = Math.max(1, Math.floor(cols.length / 8));
    for (let c = 0; c < cols.length; c += cStep) grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(xAt(c), 0, -SY / 2), new THREE.Vector3(xAt(c), 0, SY / 2),
    ]), gridMat));
    for (let r = 0; r < rows; r++) grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-SX, 0, yAt(r)), new THREE.Vector3(SX, 0, yAt(r)),
    ]), gridMat));
    // IV axis spine — a vertical at the back-left corner so the % ticks read as a
    // measured axis instead of numbers floating over the mesh.
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-SX, 0, SY / 2), new THREE.Vector3(-SX, SZ, SY / 2),
    ]), new THREE.LineBasicMaterial({ color: 0x3a5573, transparent: true, opacity: 0.6 })));
    scene.add(grp);

    // ---- HTML-overlay labels (projected each frame; never overlap) ---------
    labelLayer.replaceChildren();
    const labels: Lbl[] = [];
    const mkLabel = (text: string, anchor: THREE.Vector3, kind: "title" | "tick" | "iv", color?: string) => {
      const el = document.createElement("div");
      el.textContent = text;
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.top = "0";
      el.style.whiteSpace = "nowrap";
      el.style.pointerEvents = "none";
      el.style.fontFamily = "ui-monospace, 'JetBrains Mono', monospace";
      el.style.willChange = "transform";
      if (kind === "title") {
        el.style.fontSize = "10px";
        el.style.fontWeight = "600";
        el.style.letterSpacing = "0.16em";
        el.style.color = color ?? "#7de7ff";
        el.style.textShadow = "0 1px 6px rgba(0,0,0,0.85)";
      } else {
        el.style.fontSize = kind === "iv" ? "10.5px" : "11px";
        el.style.fontWeight = "500";
        el.style.color = color ?? "#9fb3c8";
        el.style.textShadow = "0 1px 5px rgba(0,0,0,0.9)";
      }
      labelLayer.appendChild(el);
      labels.push({ el, anchor, priority: kind === "title" ? 0 : 1 });
    };

    const TITLE = "#7de7ff";
    // moneyness ticks along the front edge + title
    const xForK = (k: number) => -SX + ((k - kLo) / (kHi - kLo || 1)) * 2 * SX;
    for (let i = 0; i <= 4; i++) {
      const k = kLo + (i / 4) * (kHi - kLo);
      const m = (Math.exp(k) - 1) * 100;
      const atm = Math.abs(m) < 0.6;
      mkLabel(atm ? "ATM" : `${m >= 0 ? "+" : ""}${m.toFixed(0)}%`, new THREE.Vector3(xForK(k), -0.04, SY / 2 + 0.5), "tick", atm ? "#cfe9ff" : "#8ea4ba");
    }
    mkLabel("MONEYNESS", new THREE.Vector3(0, -0.02, SY / 2 + 1.3), "title", TITLE);

    // tenor ticks along the right edge + title (front → back)
    const tIdx = rows <= 1 ? [0] : [...new Set([0, Math.round((rows - 1) / 3), Math.round((2 * (rows - 1)) / 3), rows - 1])];
    for (const r of tIdx) mkLabel(slices[r]?.tenor_label ?? "", new THREE.Vector3(SX + 0.75, -0.04, yAt(r)), "tick");
    mkLabel("TENOR", new THREE.Vector3(SX + 1.75, -0.02, 0), "title", TITLE);

    // IV ticks up the back-left vertical edge + title (coloured by the ramp)
    // Pick the smallest "nice" step that yields ≤3 ticks so they never crowd the
    // short vertical axis.
    const ivSpan = ivHi - ivLo;
    const ivStep = [0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 1].find((s) => ivSpan / s <= 2.2) ?? 0.5;
    const ivStart = Math.ceil((ivLo + ivStep * 0.3) / ivStep) * ivStep;
    // IV axis lives on the FRONT-left vertical edge (long-tenor corner, where the
    // surface is low) so the % ticks stand in clear space, never on the short-tenor
    // put-wing spike at the back-left.
    for (let v = ivStart; v <= ivHi - ivStep * 0.2; v += ivStep) {
      mkLabel(`${(v * 100).toFixed(0)}%`, new THREE.Vector3(-SX - 1.05, zAt(v), SY / 2), "iv", rampCss(normC(v)));
    }
    mkLabel("IV", new THREE.Vector3(-SX - 1.05, SZ + 0.5, SY / 2), "title", TITLE);

    // ---- camera auto-frame (projected corners + label gutter) --------------
    // Asymmetric gutter: just enough room for the labels on each side, tight on
    // the empty top so the surface fills the card instead of floating low.
    const bmin = new THREE.Vector3(-SX - 1.5, -0.15, -SY / 2 - 1.2);
    const bmax = new THREE.Vector3(SX + 1.9, SZ + 0.6, SY / 2 + 1.45);
    const center = new THREE.Vector3((bmin.x + bmax.x) / 2, (bmin.y + bmax.y) / 2, (bmin.z + bmax.z) / 2);
    const vFov = (camera.fov * Math.PI) / 180;
    const aspect = width / height;
    const vHalf = Math.tan(vFov / 2);
    const hHalf = vHalf * aspect;
    const dir = new THREE.Vector3(0.3, 0.62, 0.72).normalize();
    const rightV = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const upV = new THREE.Vector3().crossVectors(dir, rightV).normalize();
    let dist = 0;
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      const rel = new THREE.Vector3(xi ? bmax.x : bmin.x, yi ? bmax.y : bmin.y, zi ? bmax.z : bmin.z).sub(center);
      const fwd = rel.dot(dir);
      dist = Math.max(dist, fwd + Math.abs(rel.dot(rightV)) / hHalf, fwd + Math.abs(rel.dot(upV)) / vHalf);
    }
    dist *= 1.04; // small margin so the back corners never touch the card edges
    camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
    camera.lookAt(center);
    controls.target.copy(center);
    controls.minDistance = dist * 0.5;
    controls.maxDistance = dist * 2.2;
    // Constrain horizontal rotation to a wedge around the framing azimuth so the
    // axis edges (and their labels) can never rotate into each other / overlap.
    controls.update();
    const az0 = controls.getAzimuthalAngle();
    controls.minAzimuthAngle = az0 - 0.6;
    controls.maxAzimuthAngle = az0 + 0.6;

    // ---- project labels to screen, cull collisions -------------------------
    // Project every anchor, then greedily place by priority (titles first) and
    // HIDE any label whose screen box overlaps one already placed — so even as
    // the user orbits, ticks never pile on top of each other or the titles.
    const v3 = new THREE.Vector3();
    const updateLabels = () => {
      const w = mount.clientWidth || width;
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      const ordered = [...labels].sort((a, b) => a.priority - b.priority);
      for (const L of ordered) {
        v3.copy(L.anchor).project(camera);
        const behind = v3.z > 1;
        const sx = (v3.x * 0.5 + 0.5) * w;
        const sy = (-v3.y * 0.5 + 0.5) * height;
        L.el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
        const bw = L.el.offsetWidth || 36, bh = L.el.offsetHeight || 13;
        const box = { x: sx - bw / 2 - 3, y: sy - bh / 2 - 2, w: bw + 6, h: bh + 4 };
        let hit = behind;
        if (!hit) for (const p of placed) {
          if (box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y) { hit = true; break; }
        }
        L.el.style.opacity = hit ? "0" : "1";
        if (!hit) placed.push(box);
      }
    };

    // ---- render loop -------------------------------------------------------
    let raf = 0, disposed = false;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      updateLabels();
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth || width;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
      updateLabels();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      highlightRef.current = null;
      labelLayer.replaceChildren();
      scene.traverse((obj) => {
        const any = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        if (any.geometry) any.geometry.dispose();
        if (any.material) { const m = any.material; Array.isArray(m) ? m.forEach((mm) => mm.dispose()) : m.dispose(); }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, height]);

  useEffect(() => {
    highlightRef.current?.setSlice(selectedSlice);
  }, [selectedSlice]);

  if (failed) {
    return (
      <div style={{ width: "100%", height, borderRadius: 12, background: C.bg, border: `0.5px solid ${C.border}`, display: "grid", placeItems: "center", textAlign: "center", padding: 24 }}>
        <div>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>3D surface needs WebGL</div>
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12.5, color: C.textSecondary, marginTop: 8, maxWidth: 320, lineHeight: 1.5 }}>
            This browser/context can&apos;t open a WebGL canvas. The live smile and term-structure panels below carry the same SVI surface.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height, borderRadius: 12, overflow: "hidden", background: C.bg }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={labelRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }} />
    </div>
  );
}
