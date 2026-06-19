"use client";

// ---------------------------------------------------------------------------
// Interactive 3D implied-vol surface (three.js). Client-only: mounts a
// WebGLRenderer into a div via useEffect, builds a colour-mapped mesh over
// (x = log-moneyness, y = tenor index, z = implied vol), wires OrbitControls,
// and disposes everything on unmount (no GPU leaks).
//
// Data is the LIVE SVI surface (VolDeskSurface.slices). Each slice is one tenor
// row; each slice.points[] column is a strike / log-moneyness. We resample onto
// a shared log-moneyness grid so every row has the same column count even if the
// live points differ slightly, then triangulate. If too few live points exist we
// still render a clean small mesh from whatever is present.
// ---------------------------------------------------------------------------

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VolDeskSurface } from "../../_lib/predict-strip-client";
import { C } from "../../_lib/tokens";

// Brand-tuned IV ramp: deep ocean (low IV) -> Sui blue -> aqua -> coral (high
// IV). Mirrors the trading-desk heat convention while staying on-brand.
function ivColor(t: number): THREE.Color {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0x06 / 255, 0x24 / 255, 0x3f / 255]], // tealBg deep ocean
    [0.35, [0x4d / 255, 0xa2 / 255, 0xff / 255]], // teal
    [0.62, [0x7d / 255, 0xe7 / 255, 0xff / 255]], // tealLight aqua
    [0.82, [0xd9 / 255, 0x77 / 255, 0x06 / 255]], // amber
    [1.0, [0xea / 255, 0x58 / 255, 0x0c / 255]], // coral
  ];
  const c = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (c <= b) {
      const f = (c - a) / (b - a || 1);
      return new THREE.Color(
        ca[0] + (cb[0] - ca[0]) * f,
        ca[1] + (cb[1] - ca[1]) * f,
        ca[2] + (cb[2] - ca[2]) * f,
      );
    }
  }
  const last = stops[stops.length - 1][1];
  return new THREE.Color(last[0], last[1], last[2]);
}

export interface VolSurface3DProps {
  surface: VolDeskSurface;
  /** Index of the tenor slice currently selected in the 2D smile panel. */
  selectedSlice?: number;
  height?: number;
}

export default function VolSurface3D({ surface, selectedSlice = 0, height = 360 }: VolSurface3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // Keep the highlight ribbon mutable so slice changes don't rebuild the scene.
  const highlightRef = useRef<{ setSlice: (i: number) => void } | null>(null);
  // WebGL can be unavailable (headless renderers, blocked GPU, software contexts).
  // We must NEVER let that throw out of the effect and white-screen the desk —
  // fall back to a clean message and let the 2D smile/term panels carry the view.
  const [failed, setFailed] = React.useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const slices = surface.slices ?? [];
    if (slices.length === 0) return;

    // ---- shared log-moneyness grid (columns) ------------------------------
    // Resample every tenor onto ONE uniform column grid spanning the moneyness
    // window where ALL tenors have real data (the intersection of their strike
    // ranges). The old code took the UNION of every slice's distinct strikes —
    // with 15 tenors whose ~17 strikes don't align that is ~250 columns, and
    // each tenor only has data at its own ~17, so the other columns were
    // edge-extrapolated into flat walls: that is what tore the mesh apart. A
    // uniform intersection grid removes the extrapolation and keeps the
    // triangulation even, so the surface reads clean.
    let kLo = -Infinity, kHi = Infinity;
    for (const s of slices) {
      if (s.points.length < 2) continue;
      kLo = Math.max(kLo, s.points[0].log_moneyness);
      kHi = Math.min(kHi, s.points[s.points.length - 1].log_moneyness);
    }
    // Fall back to the union range if the intersection is empty/degenerate.
    if (!(kHi > kLo)) {
      kLo = Infinity; kHi = -Infinity;
      for (const s of slices) for (const p of s.points) { kLo = Math.min(kLo, p.log_moneyness); kHi = Math.max(kHi, p.log_moneyness); }
    }
    if (!(kHi > kLo)) return;
    const NCOL = 28;
    const cols: number[] = [];
    for (let i = 0; i < NCOL; i++) cols.push(kLo + ((kHi - kLo) * i) / (NCOL - 1));
    const rows = slices.length;
    if (cols.length < 2 || rows < 1) return;

    // Resample each slice onto the shared grid (linear interp on log-moneyness).
    const sampleIv = (s: VolDeskSurface["slices"][number], k: number): number => {
      const pts = s.points;
      if (pts.length === 0) return s.atm_iv;
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

    // Build the IV grid + find min/max for normalisation.
    const grid: number[][] = [];
    let ivMin = Infinity, ivMax = -Infinity;
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let cI = 0; cI < cols.length; cI++) {
        const v = sampleIv(slices[r], cols[cI]);
        row.push(v);
        if (v < ivMin) ivMin = v;
        if (v > ivMax) ivMax = v;
      }
      grid.push(row);
    }
    if (!isFinite(ivMin) || !isFinite(ivMax) || ivMax <= ivMin) { ivMin = 0; ivMax = Math.max(1, ivMax); }

    // ---- world-space layout ----------------------------------------------
    // Roughly-square footprint (strike × tenor) with real vertical relief so the
    // surface reads as a surface — not a thin wide ribbon lost in the panel.
    const SX = 4.6;  // log-moneyness axis half-width -> [-SX, +SX]  (x-extent 9.2)
    const SY = 8.4;  // tenor axis depth
    const SZ = 4.4;  // IV height
    const xAt = (cI: number) => -SX + (cI / (cols.length - 1)) * 2 * SX;
    const yAt = (r: number) => (rows === 1 ? 0 : -SY / 2 + (r / (rows - 1)) * SY);
    const zAt = (v: number) => ((v - ivMin) / (ivMax - ivMin)) * SZ;

    // ---- scene -----------------------------------------------------------
    const scene = new THREE.Scene();
    const width = mount.clientWidth || 600;
    const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 100);
    // Camera is auto-framed to the surface bounding box once the mesh is built.

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL context — degrade gracefully instead of throwing.
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0); // transparent -> shows card bg
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(6, 12, 8);
    scene.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;
    controls.maxPolarAngle = Math.PI * 0.49;
    // distance bounds + target are set by the auto-frame block below.

    // ---- surface mesh (vertex-coloured triangles) ------------------------
    const positions: number[] = [];
    const colors: number[] = [];
    const idx = (r: number, c: number) => r * cols.length + c;
    const vert: THREE.Vector3[] = [];
    const vcol: THREE.Color[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols.length; c++) {
        vert.push(new THREE.Vector3(xAt(c), zAt(grid[r][c]), yAt(r)));
        vcol.push(ivColor((grid[r][c] - ivMin) / (ivMax - ivMin)));
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols.length - 1; c++) {
        const a = idx(r, c), b = idx(r, c + 1), d = idx(r + 1, c), e = idx(r + 1, c + 1);
        indices.push(a, d, b, b, d, e);
      }
    }
    for (const v of vert) positions.push(v.x, v.y, v.z);
    for (const c of vcol) colors.push(c.r, c.g, c.b);

    // ---- auto-frame: snug PROJECTED-bounds fit ---------------------------
    // Fit the surface PLUS an axis-label gutter by projecting the bounding-box
    // corners onto the camera's screen axes. The bounding SPHERE (used before)
    // is far larger than the on-screen footprint for a wide, tilted, flat
    // surface, so it left the mesh tiny in dead space. Projecting the actual
    // corners sizes the surface to FILL the card while keeping the IV / TENOR /
    // strike labels (which live just outside the mesh) in frame.
    const bmin = new THREE.Vector3(-SX - 1.3, -0.3, -SY / 2 - 0.5);
    const bmax = new THREE.Vector3(SX + 1.5, SZ + 0.6, SY / 2 + 1.4);
    const center = bmin.clone().add(bmax).multiplyScalar(0.5);
    const vFov = (camera.fov * Math.PI) / 180;
    const aspect = width / height;
    const vHalf = Math.tan(vFov / 2);
    const hHalf = vHalf * aspect;
    const dir = new THREE.Vector3(0.42, 0.44, 0.86).normalize(); // center → camera
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    let dist = 0;
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      const rel = new THREE.Vector3(xi ? bmax.x : bmin.x, yi ? bmax.y : bmin.y, zi ? bmax.z : bmin.z).sub(center);
      const fwd = rel.dot(dir);
      dist = Math.max(dist, fwd + Math.abs(rel.dot(right)) / hHalf, fwd + Math.abs(rel.dot(camUp)) / vHalf);
    }
    dist *= 1.06; // small safety margin so nothing kisses the edge
    camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
    camera.lookAt(center);
    controls.target.copy(center);
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 2.4;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const surfaceMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.05,
        flatShading: false,
        transparent: true,
        opacity: 0.96,
      }),
    );
    scene.add(surfaceMesh);

    // Wireframe overlay for that "desk plot" precision.
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x0a1a2e, transparent: true, opacity: 0.22 }),
    );
    scene.add(wire);

    // ---- selected-tenor highlight ribbon ---------------------------------
    const ribbonMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0x7de7ff), linewidth: 2 });
    let ribbon: THREE.Line | null = null;
    const buildRibbon = (r: number) => {
      if (ribbon) { scene.remove(ribbon); ribbon.geometry.dispose(); }
      const rr = Math.max(0, Math.min(rows - 1, r));
      const pts: THREE.Vector3[] = [];
      for (let c = 0; c < cols.length; c++) pts.push(new THREE.Vector3(xAt(c), zAt(grid[rr][c]) + 0.04, yAt(rr)));
      const rg = new THREE.BufferGeometry().setFromPoints(pts);
      ribbon = new THREE.Line(rg, ribbonMat);
      scene.add(ribbon);
    };
    buildRibbon(selectedSlice);
    highlightRef.current = { setSlice: buildRibbon };

    // ---- ATM ridge (log-moneyness = 0) -----------------------------------
    let atmCol = 0, best = Infinity;
    for (let c = 0; c < cols.length; c++) { const d = Math.abs(cols[c]); if (d < best) { best = d; atmCol = c; } }
    const atmPts: THREE.Vector3[] = [];
    for (let r = 0; r < rows; r++) atmPts.push(new THREE.Vector3(xAt(atmCol), zAt(grid[r][atmCol]) + 0.04, yAt(r)));
    const atmLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(atmPts),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.4 }),
    );
    atmLine.computeLineDistances();
    scene.add(atmLine);

    // ---- floor grid + axes -----------------------------------------------
    const grp = new THREE.Group();
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1a2a3e, transparent: true, opacity: 0.5 });
    for (let c = 0; c < cols.length; c += Math.max(1, Math.floor(cols.length / 8))) {
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(xAt(c), 0, -SY / 2 - 0.4), new THREE.Vector3(xAt(c), 0, SY / 2 + 0.4),
      ]), gridMat));
    }
    for (let r = 0; r <= rows; r++) {
      const y = rows === 1 ? 0 : -SY / 2 + (r / Math.max(1, rows)) * SY;
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-SX - 0.4, 0, y), new THREE.Vector3(SX + 0.4, 0, y),
      ]), gridMat));
    }
    scene.add(grp);

    // axis text sprites (canvas textures) ----------------------------------
    const sprites: THREE.Sprite[] = [];
    const makeLabel = (text: string, color = "#9fb3c8", size = 46) => {
      const cv = document.createElement("canvas");
      cv.width = 256; cv.height = 64;
      const ctx = cv.getContext("2d")!;
      ctx.font = `600 ${size}px ui-monospace, monospace`;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 128, 32);
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sp.scale.set(2.6, 0.65, 1);
      sprites.push(sp);
      return sp;
    };
    // Labels sit just outside the mesh, inside the fitted gutter (bmin/bmax),
    // so they stay on-screen. Offsets reduced from the old values that clipped.
    const axX = makeLabel("LOG-MONEYNESS", "#7de7ff"); axX.position.set(0, -0.4, SY / 2 + 1.0); axX.scale.set(2.4, 0.6, 1); scene.add(axX);
    const axY = makeLabel("TENOR", "#7de7ff"); axY.position.set(SX + 1.25, -0.4, 0); axY.scale.set(1.5, 0.55, 1); scene.add(axY);
    const axZ = makeLabel("IV", "#7de7ff"); axZ.position.set(-SX - 1.05, SZ + 0.35, -SY / 2); axZ.scale.set(1.0, 0.5, 1); scene.add(axZ);
    // IV min/max tick labels
    const zHi = makeLabel(`${(ivMax * 100).toFixed(0)}%`, "#ea580c", 40); zHi.position.set(-SX - 0.85, SZ, SY / 2); zHi.scale.set(1.2, 0.48, 1); scene.add(zHi);
    const zLo = makeLabel(`${(ivMin * 100).toFixed(0)}%`, "#4da2ff", 40); zLo.position.set(-SX - 0.85, 0.1, SY / 2); zLo.scale.set(1.2, 0.48, 1); scene.add(zLo);

    // ---- render loop -----------------------------------------------------
    let raf = 0;
    let disposed = false;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // ---- resize ----------------------------------------------------------
    const onResize = () => {
      const w = mount.clientWidth || width;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // ---- teardown (no leaks) ---------------------------------------------
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      highlightRef.current = null;
      scene.traverse((obj) => {
        const any = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        if (any.geometry) any.geometry.dispose();
        if (any.material) {
          const m = any.material;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
      sprites.forEach((sp) => {
        const mat = sp.material as THREE.SpriteMaterial;
        if (mat.map) mat.map.dispose();
        mat.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // Rebuild only when the underlying surface identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, height]);

  // Slice change => just move the ribbon, no scene rebuild.
  useEffect(() => {
    highlightRef.current?.setSlice(selectedSlice);
  }, [selectedSlice]);

  if (failed) {
    return (
      <div
        style={{
          width: "100%",
          height,
          borderRadius: 12,
          background: C.bg,
          border: `0.5px solid ${C.border}`,
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>
            3D surface needs WebGL
          </div>
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12.5, color: C.textSecondary, marginTop: 8, maxWidth: 320, lineHeight: 1.5 }}>
            This browser/context can&apos;t open a WebGL canvas. The live smile and
            term-structure panels below carry the same SVI surface.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mountRef}
      style={{ width: "100%", height, borderRadius: 12, overflow: "hidden", background: C.bg }}
    />
  );
}
