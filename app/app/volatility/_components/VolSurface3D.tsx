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

type Lbl = { el: HTMLDivElement; anchor: THREE.Vector3 };

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
    // Robust scale — winsorize so the minute-tenor spike can't blow out the range.
    all.sort((a, b) => a - b);
    let ivLo = quantile(all, 0.05);
    let ivHi = quantile(all, 0.92);
    if (!(ivHi > ivLo)) { ivLo = all[0]; ivHi = Math.max(all[all.length - 1], ivLo + 0.01); }
    const norm = (v: number) => Math.max(0, Math.min(1, (v - ivLo) / (ivHi - ivLo)));

    // ---- world layout ------------------------------------------------------
    const SX = 7.4;   // moneyness half-width (wide — fills the wide analytics card)
    const SY = 5.2;   // tenor depth
    const SZ = 2.7;   // IV height
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
    const vert: THREE.Vector3[] = [];
    const vcol: THREE.Color[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols.length; c++) {
      vert.push(new THREE.Vector3(xAt(c), zAt(grid[r][c]), yAt(r)));
      vcol.push(ivColor(norm(grid[r][c])));
    }
    const idx = (r: number, c: number) => r * cols.length + c;
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols.length - 1; c++) {
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

    // faint wireframe for desk-plot precision (kept very subtle so colour leads)
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x0a1626, transparent: true, opacity: 0.14 }),
    );
    scene.add(wire);

    // ---- ATM ridge (log-moneyness 0) + selected-tenor ribbon ---------------
    let atmCol = 0, best = Infinity;
    for (let c = 0; c < cols.length; c++) { const d = Math.abs(cols[c]); if (d < best) { best = d; atmCol = c; } }
    const atmPts: THREE.Vector3[] = [];
    for (let r = 0; r < rows; r++) atmPts.push(new THREE.Vector3(xAt(atmCol), zAt(grid[r][atmCol]) + 0.03, yAt(r)));
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
      for (let c = 0; c < cols.length; c++) pts.push(new THREE.Vector3(xAt(c), zAt(grid[rr][c]) + 0.05, yAt(rr)));
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
      labels.push({ el, anchor });
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
    const ivStep = [0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 1].find((s) => ivSpan / s <= 3.0) ?? 0.5;
    const ivStart = Math.ceil((ivLo + ivStep * 0.25) / ivStep) * ivStep;
    for (let v = ivStart; v <= ivHi - ivStep * 0.15; v += ivStep) {
      mkLabel(`${(v * 100).toFixed(0)}%`, new THREE.Vector3(-SX - 0.75, zAt(v), -SY / 2), "iv", rampCss(norm(v)));
    }
    mkLabel("IV", new THREE.Vector3(-SX - 0.75, SZ + 0.55, -SY / 2), "title", TITLE);

    // ---- camera auto-frame (projected corners + label gutter) --------------
    // Asymmetric gutter: just enough room for the labels on each side, tight on
    // the empty top so the surface fills the card instead of floating low.
    const bmin = new THREE.Vector3(-SX - 1.5, -0.5, -SY / 2 - 1.2);
    const bmax = new THREE.Vector3(SX + 1.9, SZ + 0.15, SY / 2 + 1.45);
    const center = new THREE.Vector3((bmin.x + bmax.x) / 2, (bmin.y + bmax.y) / 2, (bmin.z + bmax.z) / 2);
    const vFov = (camera.fov * Math.PI) / 180;
    const aspect = width / height;
    const vHalf = Math.tan(vFov / 2);
    const hHalf = vHalf * aspect;
    const dir = new THREE.Vector3(0.34, 0.52, 0.78).normalize();
    const rightV = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const upV = new THREE.Vector3().crossVectors(dir, rightV).normalize();
    let dist = 0;
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      const rel = new THREE.Vector3(xi ? bmax.x : bmin.x, yi ? bmax.y : bmin.y, zi ? bmax.z : bmin.z).sub(center);
      const fwd = rel.dot(dir);
      dist = Math.max(dist, fwd + Math.abs(rel.dot(rightV)) / hHalf, fwd + Math.abs(rel.dot(upV)) / vHalf);
    }
    camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
    camera.lookAt(center);
    controls.target.copy(center);
    controls.minDistance = dist * 0.5;
    controls.maxDistance = dist * 2.2;

    // ---- project labels to screen ------------------------------------------
    const v3 = new THREE.Vector3();
    const updateLabels = () => {
      const w = mount.clientWidth || width;
      for (const { el, anchor } of labels) {
        v3.copy(anchor).project(camera);
        const behind = v3.z > 1;
        el.style.opacity = behind ? "0" : "1";
        const sx = (v3.x * 0.5 + 0.5) * w;
        const sy = (-v3.y * 0.5 + 0.5) * height;
        el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
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
