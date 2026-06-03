"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { Header, PageFrame } from "./app/_components/Header";
import { C, FD, FM, FS, BACKEND_URL, EASE, fmtUsd } from "./app/_lib/tokens";
import {
  DistributionCandidate,
  fetchDistributionCandidates,
} from "./app/_lib/distribution-client";

type VaultSource = { name: string; apy: number; live: boolean };

type SurfaceId = "distribution" | "basket" | "risk" | "ppn";

const SURFACES: Array<{
  id: SurfaceId;
  eyebrow: string;
  title: string;
  body: string;
  href: string;
}> = [
  {
    id: "distribution",
    eyebrow: "Curve launch",
    title: "Distribution Markets",
    body: "Quote a full probability curve against live CLOB-implied bands.",
    href: "/app/distribution",
  },
  {
    id: "basket",
    eyebrow: "PBU basket",
    title: "Market Baskets",
    body: "Deploy bundled exposure through one Sui-local position.",
    href: "/app/basket",
  },
  {
    id: "risk",
    eyebrow: "Waterfall",
    title: "Risk Slices",
    body: "Choose senior, balanced, or upside-heavy payoff exposure.",
    href: "/app/tranche",
  },
  {
    id: "ppn",
    eyebrow: "Floor target",
    title: "Protected Notes",
    body: "Route USDC into a principal sleeve with residual market upside.",
    href: "/app/ppn",
  },
];

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function shortUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return fmtUsd(value, 0);
}

function CurvePreview({
  candidate,
  active,
}: {
  candidate: DistributionCandidate | null;
  active: SurfaceId;
}) {
  const width = 620;
  const height = 260;
  const pad = 30;
  const fallback = [0.18, 0.08, 0.14, 0.31, 0.19, 0.1];
  const series = (candidate?.reference_curve.length ? candidate.reference_curve : fallback).slice(0, 8);
  const max = Math.max(...series, 0.05) * 1.2;
  const x = (index: number) => pad + (index / Math.max(1, series.length - 1)) * (width - pad * 2);
  const y = (value: number) => pad + (1 - value / max) * (height - pad * 2 - 34);
  const baseline = height - pad - 34;
  const points = series.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const area = `${points} ${x(series.length - 1)},${baseline} ${x(0)},${baseline}`;
  const topIndex = series.reduce((best, value, index) => (value > series[best] ? index : best), 0);

  return (
    <div className="home-preview">
      <div className="home-preview-head">
        <span>{SURFACES.find((surface) => surface.id === active)?.title}</span>
        <strong>{candidate ? `${candidate.clob_book_count}/${candidate.band_count} CLOB` : "Live route"}</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="home-curve" role="img" aria-label="Live distribution preview">
        <defs>
          <linearGradient id="homeCurveFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={C.tealLight} stopOpacity="0.18" />
            <stop offset="100%" stopColor={C.tealLight} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <line
            key={tick}
            x1={pad}
            x2={width - pad}
            y1={pad + tick * (height - pad * 2 - 34)}
            y2={pad + tick * (height - pad * 2 - 34)}
            stroke={C.border}
            strokeWidth="1"
            opacity="0.55"
          />
        ))}
        {series.map((value, index) => (
          <rect
            key={index}
            x={x(index) - 5}
            y={y(value)}
            width="10"
            height={baseline - y(value)}
            rx="3"
            fill={index === topIndex ? C.tealLight : C.textMuted}
            opacity={index === topIndex ? "0.34" : "0.16"}
          />
        ))}
        <polygon points={area} fill="url(#homeCurveFill)" />
        <polyline points={points} fill="none" stroke={C.tealLight} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {series.map((value, index) => (
          <g key={`point-${index}`}>
            <circle cx={x(index)} cy={y(value)} r={index === topIndex ? "4.5" : "3"} fill={C.tealLight} stroke={C.bg} strokeWidth="1.5" />
            {(series.length <= 7 || index === topIndex) && (
              <text x={x(index)} y={Math.max(12, y(value) - 10)} textAnchor="middle" fill={C.textSecondary} fontFamily={FM} fontSize="10">
                {pct(value)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="home-preview-foot">
        <span>Market depth <strong>{shortUsd(candidate?.aggregate_depth_usd ?? 2_400_000)}</strong></span>
        <span>Source <strong>Gamma + CLOB</strong></span>
        <span>Quote asset <strong>USDC</strong></span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [active, setActive] = useState<SurfaceId>("distribution");
  const [notional, setNotional] = useState(50_000);
  const [maturity, setMaturity] = useState(30);
  const [candidates, setCandidates] = useState<DistributionCandidate[]>([]);
  const [vaults, setVaults] = useState<VaultSource[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchDistributionCandidates({ limit: 4, refresh: true })
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch(() => {});
    fetch(`${BACKEND_URL}/api/vaults/yields`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setVaults(
          (body.sources ?? [])
            .filter((source: VaultSource) => typeof source?.apy === "number")
            .map((source: VaultSource) => ({ name: source.name, apy: source.apy, live: source.live }))
            .slice(0, 5),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const candidate = candidates[0] ?? null;
  const bestVault = vaults[0] ?? null;
  const selectedSurface = SURFACES.find((surface) => surface.id === active) ?? SURFACES[0];
  const fee = notional * 0.0042;
  const net = notional - fee;
  const vaultApy = bestVault?.apy ?? 0.0716;
  const protectedVaultPct = 1 / Math.pow(1 + vaultApy / 365, maturity);
  const basketPct = Math.max(0, 1 - protectedVaultPct);

  const metrics = useMemo(
    () => [
      ["Depth", shortUsd(candidate?.aggregate_depth_usd ?? 2_400_000)],
      ["CLOB books", candidate ? `${candidate.clob_book_count}/${candidate.band_count}` : "7/8"],
      ["Best USDC vault", bestVault ? `${bestVault.name} ${pct(bestVault.apy, 2)}` : "Loading"],
      ["Net route", fmtUsd(net, 0)],
    ],
    [bestVault, candidate, net],
  );

  return (
    <>
      <Header />
      <PageFrame wide>
        <style>{`
          .home-shell { max-width: 1320px; margin: 0 auto; display: grid; gap: 34px; }
          .home-hero { display: grid; grid-template-columns: minmax(0, 0.86fr) minmax(520px, 1fr); gap: 46px; align-items: center; padding: 58px 0 42px; }
          .home-kicker { color: ${C.tealLight}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 12px; }
          .home-title { color: ${C.textPrimary}; font-family: ${FD}; font-size: clamp(48px, 7vw, 96px); line-height: 0.94; letter-spacing: -0.055em; font-weight: 500; margin: 0; max-width: 680px; }
          .home-sub { color: ${C.textSubtle}; font-family: ${FS}; font-size: 16px; line-height: 1.68; max-width: 560px; margin: 22px 0 0; }
          .home-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 30px; }
          .home-primary, .home-secondary { height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; padding: 0 16px; font-family: ${FD}; font-size: 13px; font-weight: 650; text-decoration: none; transition: all 0.16s ${EASE}; }
          .home-primary { background: ${C.tealLight}; color: #06131f; border: 0.5px solid ${C.tealLight}; }
          .home-secondary { background: ${C.card}; color: ${C.textPrimary}; border: 0.5px solid ${C.border}; }
          .home-primary:hover { transform: translateY(-1px); background: ${C.teal}; }
          .home-secondary:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; }
          .home-surface-list { display: grid; gap: 2px; margin-top: 34px; max-width: 520px; }
          .home-surface-tab { width: 100%; border: 0; border-bottom: 0.5px solid ${C.border}; background: transparent; padding: 13px 0; display: grid; grid-template-columns: 118px minmax(0, 1fr) auto; gap: 16px; align-items: center; text-align: left; cursor: pointer; }
          .home-surface-tab span { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .home-surface-tab strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 14px; font-weight: 650; }
          .home-surface-tab em { color: ${C.textMuted}; font-family: ${FM}; font-size: 11px; font-style: normal; }
          .home-surface-tab.is-active { border-color: ${C.tealLight}; }
          .home-surface-tab.is-active span, .home-surface-tab.is-active em { color: ${C.tealLight}; }
          .home-panel { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; padding: 16px; box-shadow: 0 24px 80px rgba(0,0,0,0.16); }
          .home-preview { border: 0.5px solid ${C.border}; border-radius: 8px; background: ${C.surface}; padding: 14px; }
          .home-preview-head, .home-preview-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
          .home-preview-head strong, .home-preview-foot strong { color: ${C.textSecondary}; font-weight: 700; margin-left: 5px; }
          .home-preview-foot { border-top: 0.5px solid ${C.border}; padding-top: 11px; text-transform: none; letter-spacing: 0.04em; flex-wrap: wrap; }
          .home-curve { width: 100%; display: block; min-height: 280px; margin: 8px 0 2px; }
          .home-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
          .home-control { border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 12px; }
          .home-control label { display: flex; justify-content: space-between; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 10px; }
          .home-control strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 13px; }
          .home-control input { width: 100%; accent-color: ${C.tealLight}; }
          .home-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
          .home-metric { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; padding: 13px; }
          .home-metric span { display: block; color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 8px; }
          .home-metric strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
          .home-section { display: grid; gap: 14px; padding-bottom: 10px; }
          .home-section-head { display: flex; justify-content: space-between; align-items: end; gap: 20px; }
          .home-section-head h2 { margin: 0; color: ${C.textPrimary}; font-family: ${FD}; font-size: 26px; font-weight: 500; letter-spacing: -0.03em; }
          .home-section-head p { margin: 7px 0 0; color: ${C.textMuted}; font-family: ${FS}; font-size: 13px; max-width: 560px; line-height: 1.55; }
          .home-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
          .home-product { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; padding: 15px; text-decoration: none; min-height: 150px; display: flex; flex-direction: column; justify-content: space-between; transition: all 0.16s ${EASE}; }
          .home-product:hover { border-color: ${C.borderHover}; background: ${C.cardHover}; transform: translateY(-1px); }
          .home-product span { color: ${C.tealLight}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .home-product strong { display: block; color: ${C.textPrimary}; font-family: ${FD}; font-size: 16px; font-weight: 650; margin-top: 10px; }
          .home-product p { color: ${C.textMuted}; font-family: ${FS}; font-size: 12.5px; line-height: 1.5; margin: 10px 0 0; }
          .home-product em { color: ${C.textSecondary}; font-family: ${FM}; font-size: 10px; font-style: normal; }
          .home-rails { display: grid; grid-template-columns: 0.82fr 1.18fr; gap: 10px; padding-bottom: 40px; }
          .home-rail-panel { border: 0.5px solid ${C.border}; background: ${C.card}; border-radius: 8px; padding: 18px; }
          .home-rail-panel span { color: ${C.tealLight}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .home-rail-panel h3 { color: ${C.textPrimary}; font-family: ${FD}; font-size: 24px; line-height: 1.1; letter-spacing: -0.035em; font-weight: 560; margin: 12px 0 0; max-width: 420px; }
          .home-rail-panel p { color: ${C.textMuted}; font-family: ${FS}; font-size: 13px; line-height: 1.55; margin: 12px 0 0; max-width: 500px; }
          .home-rail-list { display: grid; gap: 8px; }
          .home-rail-row { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 14px; align-items: center; border: 0.5px solid ${C.border}; background: ${C.surface}; border-radius: 8px; padding: 13px; }
          .home-rail-row span { color: ${C.textMuted}; font-family: ${FM}; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
          .home-rail-row strong { color: ${C.textPrimary}; font-family: ${FD}; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .home-rail-row em { color: ${C.textSecondary}; font-family: ${FM}; font-size: 11px; font-style: normal; text-align: right; }
          @media (max-width: 1080px) {
            .home-hero { grid-template-columns: 1fr; padding-top: 24px; }
            .home-metrics, .home-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .home-rails { grid-template-columns: 1fr; }
          }
          @media (max-width: 640px) {
            .home-title { font-size: 50px; }
            .home-controls, .home-metrics, .home-grid { grid-template-columns: 1fr; }
            .home-rail-row { grid-template-columns: 1fr; }
            .home-rail-row em { text-align: left; }
            .home-surface-tab { grid-template-columns: 1fr auto; }
            .home-surface-tab span { grid-column: 1 / -1; }
          }
        `}</style>

        <div className="home-shell">
          <section className="home-hero">
            <div>
              <div className="home-kicker">Sui testnet structured markets</div>
              <h1 className="home-title">Pelagos</h1>
              <p className="home-sub">
                Build probability-market products from one focused surface: curve markets,
                PBU baskets, risk slices, and deployable protected-note strategies.
              </p>
              <div className="home-actions">
                <Link className="home-primary" href={selectedSurface.href}>
                  Open {selectedSurface.title}
                </Link>
                <Link className="home-secondary" href="/app/portfolio">
                  View portfolio
                </Link>
              </div>
              <div className="home-surface-list">
                {SURFACES.map((surface) => (
                  <button
                    key={surface.id}
                    className={`home-surface-tab${active === surface.id ? " is-active" : ""}`}
                    onClick={() => setActive(surface.id)}
                    type="button"
                  >
                    <span>{surface.eyebrow}</span>
                    <strong>{surface.title}</strong>
                    <em>{surface.id === active ? "Selected" : "View"}</em>
                  </button>
                ))}
              </div>
            </div>

            <div className="home-panel">
              <CurvePreview candidate={candidate} active={active} />
              <div className="home-controls">
                <div className="home-control">
                  <label>
                    Notional
                    <strong>{fmtUsd(notional, 0)}</strong>
                  </label>
                  <input
                    type="range"
                    min={5_000}
                    max={250_000}
                    step={5_000}
                    value={notional}
                    onChange={(event) => setNotional(Number(event.target.value))}
                  />
                </div>
                <div className="home-control">
                  <label>
                    Maturity
                    <strong>{maturity}d</strong>
                  </label>
                  <input
                    type="range"
                    min={7}
                    max={180}
                    step={1}
                    value={maturity}
                    onChange={(event) => setMaturity(Number(event.target.value))}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="home-metrics" aria-label="Live Pelagos metrics">
            {metrics.map(([label, value]) => (
              <div key={label} className="home-metric">
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>

          <section className="home-section">
            <div className="home-section-head">
              <div>
                <h2>Production Surfaces</h2>
                <p>
                  Each surface routes into the local backend and Sui testnet wiring. The
                  protected-note flow sizes the USDC vault sleeve from live Sui yield data.
                </p>
              </div>
              <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Vault split {pct(protectedVaultPct, 1)} / {pct(basketPct, 1)}
              </div>
            </div>
            <div className="home-grid">
              {SURFACES.map((surface) => (
                <Link key={surface.id} href={surface.href} className="home-product">
                  <div>
                    <span>{surface.eyebrow}</span>
                    <strong>{surface.title}</strong>
                    <p>{surface.body}</p>
                  </div>
                  <em>{surface.id === "ppn" ? `${bestVault?.name ?? "Sui"} vault · ${maturity}d` : "Open surface"}</em>
                </Link>
              ))}
            </div>
          </section>

          <section className="home-rails">
            <div className="home-rail-panel">
              <span>Execution rails</span>
              <h3>Live market data in, Sui testnet position out.</h3>
              <p>
                Pelagos keeps the product surface compact while the backend reconciles
                CLOB books, USDC routing, quote fees, and testnet write paths.
              </p>
            </div>
            <div className="home-rail-list">
              {[
                ["Market data", candidate?.title ?? "Distribution candidates", candidate ? `${candidate.clob_book_count}/${candidate.band_count} CLOB books` : "Gamma + CLOB"],
                ["Quote asset", "USDC collateral and net-route accounting", fmtUsd(net, 0)],
                ["On-chain", "Sui testnet mock-USDC package route", "configured"],
              ].map(([label, title, value]) => (
                <div className="home-rail-row" key={label}>
                  <span>{label}</span>
                  <strong>{title}</strong>
                  <em>{value}</em>
                </div>
              ))}
            </div>
          </section>
        </div>
      </PageFrame>
    </>
  );
}
