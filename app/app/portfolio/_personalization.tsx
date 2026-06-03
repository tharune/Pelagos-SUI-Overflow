"use client";

/**
 * Allocation builder.
 *
 * Calls POST /api/portfolio/construct with risk_pct, capital_usd, and an
 * objective, then renders a structured allocation plan with a strategy
 * summary, metrics, and linked allocation rows.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { C, FS, FD, FM, EASE, BACKEND_URL, fmtUsd } from "../_lib/tokens";
import { MetricTile } from "../_components/charts";
import { bundleById, type Bundle } from "../_lib/bundles";
import { useLiveBaskets } from "../_lib/use-live-baskets";

type Objective = "income" | "balanced" | "speculation";
type Horizon = "short" | "medium" | "long";
type Status = "idle" | "loading" | "success" | "error";

interface AllocationTrancheDetails {
  basket_id?: string;
  basket_name?: string;
  tier: "senior" | "mezzanine" | "junior";
  expected_yield_pct: number;
  price_per_token: number;
}

interface Allocation {
  kind: "tranche";
  weight: number;
  usd_amount: number;
  details: AllocationTrancheDetails;
  rationale: string;
}

interface PortfolioResponse {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
  risk_score: number;
  generated_at: string;
}

const OBJECTIVES: { id: Objective; label: string; sub: string }[] = [
  { id: "income",      label: "Income",      sub: "Steady yield, tight variance" },
  { id: "balanced",    label: "Balanced",    sub: "Follow the risk dial" },
  { id: "speculation", label: "Speculation", sub: "Maximise dispersion" },
];

const HORIZONS: { id: Horizon; label: string; sub: string }[] = [
  { id: "short",  label: "Short",  sub: "Under a month" },
  { id: "medium", label: "Medium", sub: "One to three months" },
  { id: "long",   label: "Long",   sub: "Three months or more" },
];

const CAPITAL_CAP = 100_000;

// Map user inputs to a real Pelagos basket from the frontend's universe so
// recommendations always link to a basket the purchase page can resolve.
// Risk → tier: 0-29 HIGH (safest 90%+), 30-69 MID, 70-100 LOW (long-tail).
// Horizon → window: short/medium/long.
function pickReferenceBasket(risk: number, horizon: Horizon, live: Bundle[] | null): Bundle | null {
  const tierCode = risk < 30 ? "HIGH" : risk < 70 ? "MID" : "LOW";
  const windowCode = horizon === "short" ? "SHORT" : horizon === "long" ? "LONG" : "MED";
  const id = `PBU-${tierCode}-${windowCode}`;
  if (live) {
    const hit = live.find((b) => b.id === id);
    if (hit) return hit;
  }
  return bundleById(id) ?? null;
}

// Objective -> implicit risk_pct. The backend prompt was built around a
// granular 0-100 risk dial, so we derive one from the chosen objective
// instead of showing a separate slider (the two were effectively asking
// the same question from the user's point of view).
const RISK_BY_OBJECTIVE: Record<Objective, number> = {
  income: 15,       // conservative: heavy senior tranche
  balanced: 50,     // middle of the road
  speculation: 85,  // aggressive: mezzanine/junior
};

export function Personalization() {
  const basketState = useLiveBaskets();
  const [capital, setCapital] = useState<string>("1000");
  const [objective, setObjective] = useState<Objective>("balanced");
  const [horizon, setHorizon] = useState<Horizon>("medium");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<PortfolioResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const capitalNum = useMemo(() => {
    const n = parseFloat(capital);
    return Number.isFinite(n) ? n : NaN;
  }, [capital]);

  const capitalValid =
    Number.isFinite(capitalNum) && capitalNum > 0 && capitalNum <= CAPITAL_CAP;

  async function generate() {
    if (!capitalValid) {
      setErrMsg(`Capital must be between $1 and $${CAPITAL_CAP.toLocaleString()}`);
      setStatus("error");
      return;
    }
    const risk = RISK_BY_OBJECTIVE[objective];
    const liveBaskets = basketState.status === "ok" ? basketState.baskets : null;
    const ref = pickReferenceBasket(risk, horizon, liveBaskets);
    if (!ref) {
      setErrMsg("No matching basket is available right now. Try again in a moment.");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setErrMsg(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/portfolio/construct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          risk_pct: risk, // derived from objective above
          capital_usd: capitalNum,
          objective,
          horizon,
          basket: {
            id: ref.id,
            name: ref.id,
            risk_tier: ref.tier,
            nav: Math.max(0.01, Math.min(0.99, ref.nav)),
            days: Math.max(1, Math.round(ref.daysLeft)),
            legs: Math.max(1, Math.round(ref.totalLegs)),
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Zod validation failures come back as { error: "validation", details: {...} }.
        // Flatten the first field issue so users see what to fix, not "400".
        let validationDetail: string | null = null;
        if (body.error === "validation" && body.details) {
          const fields = body.details.fieldErrors ?? {};
          const firstKey = Object.keys(fields)[0];
          if (firstKey && Array.isArray(fields[firstKey]) && fields[firstKey][0]) {
            validationDetail = `${firstKey}: ${fields[firstKey][0]}`;
          } else if (Array.isArray(body.details.formErrors) && body.details.formErrors[0]) {
            validationDetail = body.details.formErrors[0];
          }
        }
        const msg =
          validationDetail ||
          body.message ||
          (body.error === "timeout"
            ? "The request took too long. Try again."
            : body.error === "upstream_rate_limit"
              ? "Rate-limited right now. One moment."
              : `Request failed (${res.status})`);
        throw new Error(msg);
      }
      const data: PortfolioResponse = await res.json();
      setResult(data);
      setStatus("success");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Request failed");
      setStatus("error");
    }
  }

  function reset() {
    setStatus("idle");
    setResult(null);
    setErrMsg(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---------- Form card ---------- */}
      <div
        style={{
          background: C.card,
          border: `0.5px solid ${C.border}`,
          borderRadius: 10,
          padding: 28,
          position: "relative",
          overflow: "hidden",
        }}
        className="pelagos-card"
      >
        {/* Intro */}
        <div style={{ position: "relative", marginBottom: 28, maxWidth: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span
              style={{
                fontFamily: FM,
                fontSize: 11,
                letterSpacing: "0.14em",
                color: C.teal,
                fontWeight: 600,
              }}
            >
              ALLOCATION BUILDER
            </span>
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 300,
              color: C.textPrimary,
              fontFamily: FD,
              marginBottom: 8,
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
            }}
          >
            Build an allocation
          </div>
          <div style={{ fontSize: 13, color: C.textSecondary, fontFamily: FS, lineHeight: 1.55 }}>
            Set the capital, objective, and horizon. Pelagos maps the request to live baskets and linked risk slices.
          </div>
        </div>

        {/* Capital — stands on its own now that Risk is derived from Objective */}
        <div style={{ position: "relative" }}>
          <Field label="Capital">
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                borderBottom: `1px solid ${C.border}`,
                paddingBottom: 8,
                transition: `border-color 0.15s ${EASE}`,
              }}
            >
              <span style={{ fontSize: 28, color: C.textSecondary, fontFamily: FD, fontWeight: 300 }}>
                $
              </span>
              <input
                type="number"
                value={capital}
                onChange={(e) => {
                  setCapital(e.target.value);
                  if (status === "error") setErrMsg(null);
                }}
                placeholder="1,000"
                inputMode="decimal"
                min={1}
                max={CAPITAL_CAP}
                style={{
                  background: "transparent",
                  border: "none",
                  color: C.textPrimary,
                  fontFamily: FD,
                  fontSize: 30,
                  fontWeight: 400,
                  letterSpacing: "-0.02em",
                  padding: 0,
                  width: "100%",
                  outline: "none",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 10,
                color: C.textMuted,
                fontFamily: FM,
                letterSpacing: "0.12em",
                marginTop: 8,
              }}
            >
              $1 – ${CAPITAL_CAP.toLocaleString()} USD
            </div>
          </Field>
        </div>

        {/* Objective + Horizon — stacked full-width rows so each pill
             matches the Objective pill size. Keeps the form uniform. */}
        <div style={{ marginTop: 28 }}>
          <Field label="Objective">
            <PillGroup
              options={OBJECTIVES}
              value={objective}
              onChange={setObjective}
            />
          </Field>
        </div>
        <div style={{ marginTop: 24 }}>
          <Field label="Horizon">
            <PillGroup
              options={HORIZONS}
              value={horizon}
              onChange={setHorizon}
            />
          </Field>
        </div>

        {/* Action row */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={generate}
            disabled={status === "loading"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 22px",
              borderRadius: 10,
              border: "none",
              cursor: status === "loading" ? "wait" : "pointer",
              fontFamily: FD,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.02em",
              background: status === "loading" ? "rgba(45, 212, 191, 0.18)" : C.tealLight,
              color: status === "loading" ? C.tealLight : "#001814",
              boxShadow:
                status === "loading"
                  ? "none"
                  : `0 0 0 1px ${C.tealLight}, 0 10px 28px rgba(45, 212, 191, 0.20)`,
              transition: `all 0.15s ${EASE}`,
            }}
            onMouseEnter={(e) => {
              if (status === "loading") return;
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
              (e.currentTarget as HTMLElement).style.boxShadow = `0 0 0 1px ${C.tealLight}, 0 14px 36px rgba(45, 212, 191, 0.32)`;
            }}
            onMouseLeave={(e) => {
              if (status === "loading") return;
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
              (e.currentTarget as HTMLElement).style.boxShadow = `0 0 0 1px ${C.tealLight}, 0 10px 28px rgba(45, 212, 191, 0.20)`;
            }}
          >
            {status === "loading" ? (
              <>
                <LoadingDot />
                Constructing
              </>
            ) : (
              <>Build my portfolio →</>
            )}
          </button>

          {status !== "idle" && status !== "loading" && (
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "11px 16px",
                borderRadius: 10,
                border: `1px solid ${C.border}`,
                background: "transparent",
                color: C.textSecondary,
                cursor: "pointer",
                fontFamily: FD,
                fontSize: 12,
                letterSpacing: "0.02em",
                transition: `color 0.15s ${EASE}, border-color 0.15s ${EASE}`,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = C.textPrimary;
                (e.currentTarget as HTMLElement).style.borderColor = C.borderHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = C.textSecondary;
                (e.currentTarget as HTMLElement).style.borderColor = C.border;
              }}
            >
              Reset
            </button>
          )}

          {errMsg && (
            <div
              style={{
                fontSize: 12,
                color: C.red,
                fontFamily: FS,
                lineHeight: 1.4,
                flex: "1 0 100%",
                paddingTop: 2,
              }}
            >
              {errMsg}
            </div>
          )}
        </div>
      </div>

      {/* ---------- Loading skeleton ---------- */}
      {status === "loading" && <LoadingSkeleton />}

      {/* ---------- Result ---------- */}
      {status === "success" && result && <ResultView result={result} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Field({
  label,
  children,
  labelColor,
}: {
  label: string;
  children: React.ReactNode;
  labelColor?: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: labelColor ?? C.textMuted,
          fontFamily: FM,
          letterSpacing: "0.18em",
          marginBottom: 14,
          fontWeight: 500,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// Reusable 3-card pill picker. Generic in the option id so Objective and
// Horizon can share the same render path without type loss.
function PillGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; sub: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, gap: 10 }}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              textAlign: "left",
              padding: "14px 16px",
              borderRadius: 10,
              border: `1px solid ${active ? `${C.tealLight}66` : "rgba(255, 255, 255, 0.08)"}`,
              background: active
                ? "rgba(45, 212, 191, 0.08)"
                : C.surface,
              color: active ? C.textPrimary : C.textSecondary,
              cursor: "pointer",
              transition: `background 0.15s ${EASE}, border-color 0.15s ${EASE}, color 0.15s ${EASE}`,
            }}
            onMouseEnter={(e) => {
              if (active) return;
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255, 255, 255, 0.14)";
              (e.currentTarget as HTMLElement).style.background = C.cardHover;
            }}
            onMouseLeave={(e) => {
              if (active) return;
              (e.currentTarget as HTMLElement).style.borderColor = "rgba(255, 255, 255, 0.08)";
              (e.currentTarget as HTMLElement).style.background = C.surface;
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: active ? C.tealLight : C.textPrimary,
                fontFamily: FD,
                letterSpacing: "-0.005em",
                marginBottom: 4,
              }}
            >
              {o.label}
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FS, lineHeight: 1.35 }}>
              {o.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function LoadingDot() {
  return (
    <>
      <style>{`
        @keyframes pbuDot { 0% { transform: scale(0.8); opacity: 0.4; } 50% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(0.8); opacity: 0.4; } }
      `}</style>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: C.tealLight,
          display: "inline-block",
          animation: "pbuDot 1.1s ease-in-out infinite",
        }}
      />
    </>
  );
}

function LoadingSkeleton() {
  return (
    <>
      <style>{`
        @keyframes pbuShimmer { 0% { background-position: -300px 0; } 100% { background-position: 300px 0; } }
        .pbu-shimmer {
          background: linear-gradient(90deg, rgba(45, 212, 191, 0.03) 0%, rgba(45, 212, 191, 0.09) 50%, rgba(45, 212, 191, 0.03) 100%);
          background-size: 600px 100%;
          animation: pbuShimmer 1.8s linear infinite;
        }
      `}</style>
      <div
        style={{
          background: C.surface,
          border: `0.5px solid ${C.border}`,
          borderRadius: 16,
          padding: "24px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div className="pbu-shimmer" style={{ height: 12, width: "40%", borderRadius: 4 }} />
        <div className="pbu-shimmer" style={{ height: 14, width: "90%", borderRadius: 4 }} />
        <div className="pbu-shimmer" style={{ height: 14, width: "70%", borderRadius: 4 }} />
        <div style={{ height: 1, background: C.border, margin: "8px 0" }} />
        {[1, 2, 3].map((i) => (
          <div key={i} className="pbu-shimmer" style={{ height: 52, borderRadius: 10 }} />
        ))}
      </div>
    </>
  );
}

function ResultView({ result }: { result: PortfolioResponse }) {
  const riskColor =
    result.risk_score > 70 ? C.coral : result.risk_score > 40 ? C.amber : C.tealLight;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Strategy + metrics */}
      <div
        style={{
          background: C.surface,
          border: `0.5px solid ${C.border}`,
          borderRadius: 10,
          padding: "26px 28px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span
            style={{
              fontFamily: FM,
              fontSize: 10,
              letterSpacing: "0.22em",
              color: C.tealLight,
              fontWeight: 500,
            }}
          >
            STRATEGY
          </span>
        </div>
        <div
          style={{
            fontSize: 16,
            lineHeight: 1.55,
            color: C.textPrimary,
            fontFamily: FS,
            fontWeight: 300,
            marginBottom: 22,
            maxWidth: 820,
            position: "relative",
          }}
        >
          {result.summary}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <MetricTile
            label="EXPECTED APY"
            value={`${result.expected_apy_low.toFixed(1)}% – ${result.expected_apy_high.toFixed(1)}%`}
          />
          <MetricTile
            label="RISK SCORE"
            value={`${result.risk_score}/100`}
            color={riskColor}
            sub={
              result.risk_score > 70
                ? "Aggressive"
                : result.risk_score > 40
                  ? "Moderate"
                  : "Conservative"
            }
          />
          <MetricTile
            label="ALLOCATIONS"
            value={`${result.allocations.length}`}
            sub="positions across primitives"
          />
        </div>
      </div>

      {/* Allocation list header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 6px",
          marginTop: 4,
        }}
      >
        <div
          style={{
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.22em",
            color: C.textMuted,
            fontWeight: 500,
          }}
        >
          ALLOCATIONS
        </div>
        <div
          style={{
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.textMuted,
          }}
        >
          GENERATED {new Date(result.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {result.allocations.map((a, i) => (
          <AllocationRow key={i} a={a} />
        ))}
      </div>
    </div>
  );
}

function AllocationRow({ a }: { a: Allocation }) {
  const d = a.details;
  const accent =
    d.tier === "senior" ? C.tealLight : d.tier === "mezzanine" ? C.amber : C.coral;
  const tag = `TRANCHE · ${String(d.tier ?? "").toUpperCase()}`;
  const title = d.basket_name || "Pelagos basket";
  const yield_ = Number.isFinite(d.expected_yield_pct) ? d.expected_yield_pct.toFixed(1) : "—";
  const price = Number.isFinite(d.price_per_token) ? d.price_per_token.toFixed(4) : "—";
  const sub = `Expected yield ${yield_}% · price $${price} / $1 face`;
  const qs = new URLSearchParams();
  if (d.tier) qs.set("tier", d.tier);
  if (Number.isFinite(a.usd_amount)) qs.set("amount", a.usd_amount.toFixed(2));
  const href = d.basket_id
    ? `/app/tranche/${d.basket_id}?${qs.toString()}`
    : `/app/tranche?${qs.toString()}`;

  return (
    <Link
      href={href}
      style={{
        display: "grid",
        gridTemplateColumns: "4px minmax(0, 1fr) auto",
        gap: 18,
        background: C.surface,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: "18px 22px",
        transition: `border-color 0.2s ${EASE}, background 0.2s ${EASE}, transform 0.2s ${EASE}`,
        textDecoration: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = `${accent}55`;
        el.style.background = C.cardHover;
        el.style.transform = "translateY(-1px)";
        const chev = el.querySelector("[data-chev]") as HTMLElement | null;
        if (chev) chev.style.transform = "translateX(2px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = C.border;
        el.style.background = C.surface;
        el.style.transform = "translateY(0)";
        const chev = el.querySelector("[data-chev]") as HTMLElement | null;
        if (chev) chev.style.transform = "translateX(0)";
      }}
    >
      <div style={{ background: accent, borderRadius: 2, alignSelf: "stretch" }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span
            style={{
              fontSize: 10,
              color: accent,
              fontFamily: FM,
              letterSpacing: "0.18em",
              fontWeight: 500,
            }}
          >
            {tag}
          </span>
          <span
            style={{
              fontSize: 9,
              color: C.textMuted,
              fontFamily: FM,
              letterSpacing: "0.14em",
              padding: "2px 7px",
              border: `0.5px solid ${C.border}`,
              borderRadius: 4,
            }}
          >
            BUY →
          </span>
        </div>
        <div
          style={{
            fontSize: 14,
            color: C.textPrimary,
            fontFamily: FD,
            fontWeight: 500,
            marginBottom: 4,
            lineHeight: 1.3,
            letterSpacing: "-0.005em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: C.textMuted,
            fontFamily: FS,
            marginBottom: 10,
          }}
        >
          {sub}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: C.textSecondary,
            fontFamily: FS,
            lineHeight: 1.55,
          }}
        >
          {a.rationale}
        </div>
      </div>
      <div style={{ textAlign: "right", alignSelf: "start", minWidth: 96, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <div
          style={{
            fontSize: 22,
            color: accent,
            fontFamily: FD,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          {(a.weight * 100).toFixed(1)}%
        </div>
        <div
          style={{
            fontSize: 12,
            color: C.textMuted,
            fontFamily: FM,
            marginTop: 6,
            letterSpacing: "0.02em",
          }}
        >
          {fmtUsd(a.usd_amount, 0)}
        </div>
        <div
          data-chev
          aria-hidden
          style={{
            marginTop: 10,
            color: accent,
            opacity: 0.8,
            transition: `transform 0.2s ${EASE}`,
            display: "inline-flex",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6 L15 12 L9 18" />
          </svg>
        </div>
      </div>
    </Link>
  );
}
