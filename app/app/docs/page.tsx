"use client";

/**
 * About & docs surface, styled after aave.com/docs:
 *   • Left sidebar with top-level sections, each holding a list of
 *     sub-pages. Active item highlighted. Click a sub-page to swap the
 *     main content.
 *   • Single centred content column with plain prose, minimal colour,
 *     one brand accent (Sui Ocean). Tables and code blocks are flat
 *     and quiet.
 *   • A short, honest testnet note at the very top of every view.
 *
 * Content is kept factually in sync with README.md, ARCHITECTURE.md,
 * README_DEEPBOOK.md, and DEPLOYMENT.md. Nothing on the pricing/settlement
 * path is invented: every claim maps to a real route, package, or flow.
 */

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Header, PageFrame } from "../_components/Header";
import { C, FS, FD, FM, EASE } from "../_lib/tokens";

// ---------------------------------------------------------------------------
// Content tree
// ---------------------------------------------------------------------------

interface DocPage {
  id: string;
  label: string;
  render: () => React.ReactNode;
}
interface DocSection {
  id: string;
  label: string;
  pages: DocPage[];
}

const SECTIONS: DocSection[] = [
  {
    id: "overview",
    label: "Overview",
    pages: [
      { id: "what-is-pelagos", label: "What is Pelagos",   render: () => <WhatIsPelagos /> },
      { id: "product-suite",   label: "Product suite",     render: () => <ProductSuite /> },
      { id: "architecture",    label: "Architecture",      render: () => <Architecture /> },
      { id: "non-custodial",   label: "Non-custodial flow", render: () => <NonCustodial /> },
    ],
  },
  {
    id: "deepbook-predict",
    label: "DeepBook Predict",
    pages: [
      { id: "dbp-primitives",  label: "Binary & range",    render: () => <DbpPrimitives /> },
      { id: "dbp-pricing",     label: "Live MM pricing",   render: () => <DbpPricing /> },
      { id: "dbp-oracle",      label: "SVI oracle & expiries", render: () => <DbpOracle /> },
      { id: "dbp-strip",       label: "The range strip",   render: () => <DbpStrip /> },
    ],
  },
  {
    id: "products",
    label: "Products",
    pages: [
      { id: "p-distributed",   label: "Distributed Options", render: () => <PDistributed /> },
      { id: "p-volatility",    label: "Volatility",        render: () => <PVolatility /> },
      { id: "p-distribution",  label: "Distribution Markets", render: () => <PDistribution /> },
      { id: "p-slices",        label: "Risk Slices",       render: () => <PSlices /> },
      { id: "p-notes",         label: "Protected Notes",   render: () => <PNotes /> },
      { id: "p-baskets",       label: "Baskets",           render: () => <PBaskets /> },
    ],
  },
  {
    id: "rails",
    label: "Settlement rails",
    pages: [
      { id: "rails-overview",  label: "dUSDC & Pelagos USDC", render: () => <RailsOverview /> },
      { id: "rails-lifecycle", label: "Quote to position", render: () => <RailsLifecycle /> },
    ],
  },
  {
    id: "onchain",
    label: "On-chain",
    pages: [
      { id: "chain-packages",  label: "Move packages",     render: () => <ChainPackages /> },
      { id: "chain-deploy",    label: "Live deployment",   render: () => <ChainDeploy /> },
    ],
  },
  {
    id: "developers",
    label: "Developers",
    pages: [
      { id: "dev-api",         label: "API reference",     render: () => <DevApi /> },
      { id: "dev-repo",        label: "Repository layout", render: () => <DevRepo /> },
    ],
  },
  {
    id: "risks",
    label: "Risks",
    pages: [
      { id: "risk-summary",    label: "Risk summary",      render: () => <RiskSummary /> },
    ],
  },
  {
    id: "faq",
    label: "FAQ",
    pages: [
      { id: "faq-all",         label: "Frequently asked",  render: () => <FaqAll /> },
    ],
  },
];

const ALL_PAGES: DocPage[] = SECTIONS.flatMap((s) => s.pages);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].pages[0].id);
  const activePage = useMemo(
    () => ALL_PAGES.find((p) => p.id === activeId) ?? ALL_PAGES[0],
    [activeId],
  );
  return (
    <>
      <Header />
      <PageFrame>
        <style>{`
          @media (max-width: 860px) {
            .pelagos-docs-grid { grid-template-columns: 1fr !important; }
            .pelagos-docs-sidebar { position: static !important; max-height: none !important; }
          }
        `}</style>
        <div
          className="pelagos-docs-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 250px) minmax(0, 1fr)",
            gap: 56,
            alignItems: "flex-start",
          }}
        >
          <Sidebar activeId={activeId} onSelect={setActiveId} />
          <article
            style={{
              minWidth: 0,
              maxWidth: 760,
              color: C.textPrimary,
              fontFamily: FS,
              fontSize: 15,
              lineHeight: 1.72,
            }}
          >
            <HackathonNote />
            <PageTitle page={activePage} />
            {activePage.render()}
            <PageNav activeId={activeId} onSelect={setActiveId} />
          </article>
        </div>
      </PageFrame>
    </>
  );
}

// ---------------------------------------------------------------------------
// Testnet note
// ---------------------------------------------------------------------------

/**
 * Honest disclaimer shown at the top of every documentation page.
 * Standard warning-box styling (amber left border, muted background,
 * bold label). Covers the hackathon scope: testnet only, no mainnet,
 * no real capital, not investment advice.
 */
function HackathonNote() {
  return (
    <aside
      role="note"
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${C.amber}`,
        borderRadius: 10,
        padding: "22px 26px",
        marginBottom: 32,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 11,
          letterSpacing: "0.22em",
          fontWeight: 600,
          color: C.textPrimary,
          textTransform: "uppercase",
          marginBottom: 14,
        }}
      >
        Testnet — no real value
      </div>
      <p
        style={{
          margin: 0,
          fontFamily: FS,
          fontSize: 14,
          lineHeight: 1.65,
          color: C.textSecondary,
          maxWidth: 640,
        }}
      >
        Pelagos is a hackathon project for the DeepBook Predict track,
        deployed to Sui testnet only (chain <code style={{ fontFamily: FM, fontSize: "0.86em" }}>4c78adac</code>).
        It is not a financial product, a securities offering, or
        investment advice, and no real capital is routed through any of
        its flows. Prices and settlement are live off real DeepBook
        Predict liquidity, but every balance — both dUSDC and Pelagos
        USDC — is a testnet token with no monetary value. There are no
        plans to deploy to mainnet, issue a token, or continue
        maintenance after the event.
      </p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({
  activeId,
  onSelect,
}: {
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Docs"
      className="pelagos-docs-sidebar"
      style={{
        position: "sticky",
        top: 80,
        alignSelf: "flex-start",
        maxHeight: "calc(100vh - 120px)",
        overflowY: "auto",
        paddingRight: 8,
        paddingBottom: 24,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 10,
          letterSpacing: "0.2em",
          color: C.textMuted,
          fontWeight: 500,
          marginBottom: 18,
        }}
      >
        ABOUT &amp; DOCS
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {SECTIONS.map((section) => (
          <SidebarSection
            key={section.id}
            section={section}
            activeId={activeId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </nav>
  );
}

function SidebarSection({
  section,
  activeId,
  onSelect,
}: {
  section: DocSection;
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: FD,
          fontSize: 12.5,
          fontWeight: 600,
          color: C.textPrimary,
          letterSpacing: "-0.005em",
          marginBottom: 8,
          textTransform: "none",
        }}
      >
        {section.label}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {section.pages.map((p) => {
          const active = activeId === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  border: "none",
                  borderRadius: 6,
                  background: active ? `${C.teal}14` : "transparent",
                  color: active ? C.tealLight : C.textSecondary,
                  fontFamily: FS,
                  fontSize: 13,
                  fontWeight: active ? 500 : 400,
                  lineHeight: 1.45,
                  cursor: "pointer",
                  transition: `color 0.15s ${EASE}, background 0.15s ${EASE}`,
                }}
                onMouseEnter={(e) => {
                  if (active) return;
                  (e.currentTarget as HTMLElement).style.color = C.textPrimary;
                }}
                onMouseLeave={(e) => {
                  if (active) return;
                  (e.currentTarget as HTMLElement).style.color = C.textSecondary;
                }}
              >
                {p.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content heading
// ---------------------------------------------------------------------------

function PageTitle({ page }: { page: DocPage }) {
  const section = SECTIONS.find((s) => s.pages.some((p) => p.id === page.id));
  return (
    <div style={{ marginBottom: 22 }}>
      {section && (
        <div
          style={{
            fontFamily: FM,
            fontSize: 10,
            letterSpacing: "0.18em",
            color: C.textMuted,
            fontWeight: 500,
            marginBottom: 8,
            textTransform: "uppercase",
          }}
        >
          {section.label}
        </div>
      )}
      <h1
        style={{
          fontFamily: FD,
          fontSize: 30,
          fontWeight: 400,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          margin: 0,
          color: C.textPrimary,
        }}
      >
        {page.label}
      </h1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prev / next footer nav (keeps the doc set fully traversable in order)
// ---------------------------------------------------------------------------

function PageNav({
  activeId,
  onSelect,
}: {
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const idx = ALL_PAGES.findIndex((p) => p.id === activeId);
  const prev = idx > 0 ? ALL_PAGES[idx - 1] : null;
  const next = idx < ALL_PAGES.length - 1 ? ALL_PAGES[idx + 1] : null;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginTop: 44,
        paddingTop: 22,
        borderTop: `0.5px solid ${C.border}`,
      }}
    >
      <PageNavButton page={prev} dir="prev" onSelect={onSelect} />
      <PageNavButton page={next} dir="next" onSelect={onSelect} />
    </div>
  );
}

function PageNavButton({
  page,
  dir,
  onSelect,
}: {
  page: DocPage | null;
  dir: "prev" | "next";
  onSelect: (id: string) => void;
}) {
  if (!page) return <span style={{ flex: 1 }} />;
  return (
    <button
      type="button"
      onClick={() => onSelect(page.id)}
      style={{
        flex: 1,
        textAlign: dir === "next" ? "right" : "left",
        background: "transparent",
        border: `0.5px solid ${C.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        cursor: "pointer",
        transition: `border-color 0.15s ${EASE}`,
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = `${C.teal}66`)
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = C.border)
      }
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.textMuted,
          marginBottom: 4,
        }}
      >
        {dir === "prev" ? "Previous" : "Next"}
      </div>
      <div style={{ fontFamily: FD, fontSize: 14, fontWeight: 500, color: C.tealLight }}>
        {page.label}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pages — Overview
// ---------------------------------------------------------------------------

function WhatIsPelagos() {
  return (
    <>
      <P>
        Pelagos turns prediction-market outcomes into clean, tradeable{" "}
        <B>structured products</B> on Sui, priced and settled on{" "}
        <B>DeepBook Predict</B>. The flagship is a continuous view of where
        an asset lands — drag a mean and a width, and Pelagos mints exactly
        the basket of real on-chain range-options that expresses it, in one
        wallet signature.
      </P>
      <P>
        Everything on the pricing and settlement path is real. Each contract
        is a DeepBook Predict range with a $1 binary payout, priced live off
        the protocol&apos;s own bid/ask via{" "}
        <Code>get_range_trade_amounts</Code> and settled natively on chain.
        No number on the pricing path is invented or linearly interpolated.
      </P>
      <SubHeading>One engine, five shapes</SubHeading>
      <P>
        Under the hood every Pelagos product is the <B>same range-strip
        engine</B> with a different parameterisation. A strip is a set of
        adjacent Predict ranges, weighted by a Normal(μ, σ) mass, that
        reproduces a distributional view as a payoff. Change what μ and σ
        mean and you get a different product:
      </P>
      <UL
        items={[
          <>
            <B>Distributed Options</B> — a live BTC options chain, every
            strike a Predict range priced off real liquidity.
          </>,
          <>
            <B>Volatility</B> — prebuilt vol structures (straddle, strangle,
            butterfly, iron condor) with a live payoff diagram, greeks, and a
            delta-hedge sleeve.
          </>,
          <>
            <B>Distribution Markets</B> — the raw range ladder: a μ/σ view
            minted as N weighted buckets.
          </>,
          <>
            <B>Risk Slices</B> — the same strip taken at senior / mezzanine /
            junior widths (0.5σ / 1.0σ / 2.0σ).
          </>,
          <>
            <B>Protected Notes</B> — a principal floor supplied to the PLP
            vault, paired with a range-strip upside sleeve.
          </>,
        ]}
      />
      <SubHeading>Two interfaces</SubHeading>
      <P>
        A global <B>Basic / Advanced</B> toggle in the header reskins every
        product. Basic is clean, guided, and prebuilt. Advanced is the
        institutional desk: order books, an interactive 3D SVI vol surface,
        the risk-slice tranching engine, full greeks, and on-chain
        deployment detail. The toggle, the light/dark theme, and{" "}
        <Code>?mode=</Code> / <Code>?theme=</Code> deep links all persist
        per browser.
      </P>
      <SubHeading>Non-custodial by construction</SubHeading>
      <P>
        The backend is a pricing and orchestration layer that builds{" "}
        <B>unsigned</B> programmable transaction blocks. The user&apos;s
        wallet signs and executes them, and the user&apos;s wallet owns the
        on-chain <Code>PredictManager</Code> that gates every mint and
        redeem. The backend never custodies user funds.
      </P>
    </>
  );
}

function ProductSuite() {
  return (
    <>
      <P>
        Pelagos ships a full structured-product suite over one shared,
        real-priced strip engine. The primary navigation is{" "}
        <B>Portfolio · Distributed Options · Volatility · DeepBook · Baskets ·
        About</B>. The table below maps each product to the Predict primitive
        it is built from.
      </P>
      <Table
        cols={["Product", "What it is", "Predict mapping"]}
        rows={[
          [
            "Distributed Options",
            "Live BTC options chain — calls and puts across every on-chain expiry (≈15m → 22d), each a $1 binary settled on Sui.",
            "Per-strike DeepBook Predict range, priced live off the protocol&apos;s own bid/ask.",
          ],
          [
            "Volatility",
            "Implied-vs-realized vol with prebuilt structures, a live payoff diagram, greeks, and a delta-hedge sleeve. Advanced adds a 3D SVI surface.",
            "Multi-leg range strips; greeks computed off the live SVI smile.",
          ],
          [
            "Distribution Markets",
            "A continuous μ/σ view minted as N weighted range buckets — the raw range ladder.",
            "buildStripBuckets → N on-grid mint_range buckets weighted by Normal mass.",
          ],
          [
            "Risk Slices",
            "Senior, mezzanine, and junior risk appetites on the same underlying strip.",
            "The same strip at 0.5σ / 1.0σ / 2.0σ width — narrow ATM is high hit-rate / low multiple, wide is convex / low hit-rate / high multiple.",
          ],
          [
            "Protected Notes",
            "A principal floor plus capped upside, sized to a chosen floor percentage.",
            "Floor sleeve → predict::supply (PLP yield); upside sleeve → a range strip; both in one PTB.",
          ],
          [
            "Baskets",
            "Curated DeepBook recipes plus diversified Polymarket event baskets, de-correlated by an NLP layer.",
            "Named μ/σ presets over the live oracle (Predict) and CLOB-priced event legs on Pelagos&apos;s own vault (Pelagos USDC).",
          ],
        ]}
      />
      <SubHeading>Shared surfaces</SubHeading>
      <P>
        Every product reads from the same backend and writes through the same
        non-custodial prepare / sign / confirm flow. The{" "}
        <DocLink href="/app/portfolio">Portfolio</DocLink> view aggregates
        holdings across products with live mark-to-market, P&amp;L, and
        per-strategy backtests on real price history.
      </P>
      <SubHeading>Where each lives</SubHeading>
      <UL
        items={[
          <>
            <DocLink href="/app/distribution">Distributed Options</DocLink>{" "}
            — the BTC chain and the distribution range ladder.
          </>,
          <>
            <DocLink href="/app/volatility">Volatility</DocLink> — vol
            structures, the SVI surface, and the multi-leg builder.
          </>,
          <>
            <DocLink href="/app/deepbook">DeepBook</DocLink> — prebuilt range
            strategies and Protected Notes.
          </>,
          <>
            <DocLink href="/app/basket">Baskets</DocLink> — DeepBook recipes
            and Polymarket event baskets, with the Risk Slices tranching
            engine in Advanced.
          </>,
        ]}
      />
    </>
  );
}

function Architecture() {
  return (
    <>
      <P>
        Pelagos is three surfaces: a Next.js frontend, an Express backend, and
        Move packages on Sui testnet — plus Mysten&apos;s DeepBook Predict,
        which Pelagos calls but does not deploy. The frontend never contacts
        upstream pricing or settlement directly; all on-chain reads, PTB
        builds, and external data flow through the backend.
      </P>
      <SubHeading>Topology</SubHeading>
      <CodeBlock>
        {`Next.js frontend  :13100   forked Next.js; app dir = app/app/
      │  wallet-signed PTBs (@mysten/dapp-kit)
      ▼
Express API       :13101   builds UNSIGNED tx_bytes; non-custodial
      ├── DeepBook Predict   range pricing · SVI surface · settlement
      ├── Polymarket CLOB    event-basket markets + midpoint pricing
      ├── DeFiLlama          live Sui USDC lending APY (note floors)
      ├── Coinbase           BTC candles (backtests)
      └── Sui RPC            pelagos_sui / _vault / _strategies moveCalls
      │
      └── Monitor :13102     process / API / on-chain / market metrics`}
      </CodeBlock>
      <SubHeading>Backend engines</SubHeading>
      <UL
        items={[
          <>
            <B>predict/</B> — the SVI surface, implied density, range-strip
            pricing, and mint PTBs. The shared core under Distributed
            Options, Volatility, Distribution, Risk Slices, and Notes.
          </>,
          <>
            <B>options-chain</B> — the BTC options chain: each strike priced
            off Predict range liquidity, IV from the live SVI smile,
            depth and risk caps per strike.
          </>,
          <>
            <B>volatility</B> — prebuilt vol structures and greeks.
          </>,
          <>
            <B>baskets / market-filter / nlp</B> — Polymarket discovery
            through a 5-stage NLP quality filter, correlation-decorrelated
            weighting, and tranching.
          </>,
          <>
            <B>vault / sui / pelagos-chain</B> — the on-chain moveCall and
            PTB builders.
          </>,
        ]}
      />
      <SubHeading>Why a proxy backend</SubHeading>
      <P>
        Routing every on-chain read and external call through the backend
        centralises caching, rate limiting, schema normalisation, and PTB
        construction. It also keeps signing on the client: the backend
        computes and dry-runs transactions but holds no user keys for the
        structured-product path.
      </P>
    </>
  );
}

function NonCustodial() {
  return (
    <>
      <P>
        The structured-product path is non-custodial end to end. The backend
        builds an unsigned transaction, dry-runs a throwaway copy for a
        gas and feasibility estimate, and returns{" "}
        <Code>{`{ tx_bytes, sender, dry_run }`}</Code>. The user&apos;s wallet
        signs and executes; the user&apos;s wallet owns the{" "}
        <Code>PredictManager</Code> whose <Code>owner</Code> field gates
        mint, redeem, deposit, and withdraw.
      </P>
      <SubHeading>Prepare → sign → confirm</SubHeading>
      <OL
        items={[
          <>
            <B>Prepare.</B> The frontend posts a quote request (μ/σ, budget,
            floor percentage, basket id) to a <Code>/prepare</Code> route.
            The backend prices the legs against live Predict liquidity and
            returns unsigned <Code>tx_bytes</Code> plus a dry-run result.
          </>,
          <>
            <B>Sign.</B> The wallet (<Code>@mysten/dapp-kit</Code>) signs the
            bytes. On a first open the manager-creation step is bundled so
            the whole position is one signature.
          </>,
          <>
            <B>Confirm.</B> The frontend posts the executed digest to{" "}
            <Code>/confirm</Code>, which verifies the transaction on chain
            and surfaces the emitted events and any newly created manager id.
          </>,
        ]}
      />
      <SubHeading>The two write paths</SubHeading>
      <P>
        The non-custodial prepare/sign/confirm path drives every
        structured product. A separate custodial, backend-signed path also
        exists for the single-strike binary tab and scripted end-to-end
        tests; it requires a configured server signer and is never on the
        user-facing structured-product route.
      </P>
      <SubHeading>What the backend never does</SubHeading>
      <P>
        The backend does not hold user keys, does not take custody of
        collateral, and cannot move a position the user did not sign for.
        Its reads run through <Code>devInspect</Code> — pricing and
        simulation that touch no funds and need no signer.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — DeepBook Predict
// ---------------------------------------------------------------------------

function DbpPrimitives() {
  return (
    <>
      <P>
        DeepBook Predict is Mysten&apos;s on-chain prediction protocol. Over a
        BTC SVI vol-surface oracle it exposes two primitives that Pelagos
        builds everything from.
      </P>
      <UL
        items={[
          <>
            <B>Binary.</B> Pays $1 per contract if settlement is above (UP)
            or at/below (DOWN) a single strike. A single-strike directional
            bet.
          </>,
          <>
            <B>Range (vertical).</B> A{" "}
            <Code>RangeKey{`{ oracle_id, expiry, lower, higher }`}</Code>{" "}
            pays $1 per contract iff settlement lands in{" "}
            <Code>(lower, higher]</Code>. Fair value is{" "}
            <Code>up(lower) − up(higher)</Code>.
          </>,
        ]}
      />
      <SubHeading>From one strike to a view</SubHeading>
      <P>
        A binary lets you bet on one strike. Pelagos&apos;s insight is that a
        strip of adjacent ranges, weighted by a Normal(μ, σ) mass, is a
        payoff that mirrors a whole distributional view. Drag μ for direction
        and σ for conviction and width, and you mint exactly the basket of
        real range-options that expresses it.
      </P>
      <SubHeading>Units and scales</SubHeading>
      <P>
        Scales are enforced in one place so the math stays consistent across
        the whole engine:
      </P>
      <Table
        cols={["Quantity", "Scale", "Meaning"]}
        rows={[
          ["Strikes, spot, forward, probabilities", "1e9", "PRICE_SCALE fixed-point."],
          ["dUSDC cash", "1e6", "Micro-dUSDC (6 decimals)."],
          ["Contract quantity", "1,000,000 = 1 contract", "One contract pays $1 at settlement."],
        ]}
      />
    </>
  );
}

function DbpPricing() {
  return (
    <>
      <P>
        This is the heart of the integration: no price on the path is
        invented or linearly interpolated. Every bucket price comes from the
        protocol&apos;s own <Code>get_range_trade_amounts</Code> via{" "}
        <Code>devInspect</Code> — no funds, no signer required.
      </P>
      <SubHeading>How a strip is priced at real size</SubHeading>
      <OL
        items={[
          <>
            <B>Build buckets.</B> Slice <Code>Normal(μ, σ)</Code> into N
            contiguous, on-grid, non-overlapping buckets spanning{" "}
            <Code>±spanSigma·σ</Code>. Each bucket&apos;s weight is its Normal
            mass <Code>Φ((higher−μ)/σ) − Φ((lower−μ)/σ)</Code>.
          </>,
          <>
            <B>Marginal ask.</B> One preview per bucket at quantity = 1
            contract gives the per-contract ask with no size impact — the
            sizing and slippage reference.
          </>,
          <>
            <B>Size ∝ Normal weight.</B> Quantities are allocated so the
            payout mirrors the view and total marginal cost ≈ budget.
          </>,
          <>
            <B>Re-price at real quantity.</B> Call{" "}
            <Code>get_range_trade_amounts</Code> again at each bucket&apos;s
            real quantity. Because the protocol prices against post-trade
            vault state, the returned cost already includes the MM spread and
            the slippage from the liability the order adds.
          </>,
          <>
            <B>One budget correction.</B> If real total cost drifts more than
            5% from the budget, quantities are scaled once and re-priced.
          </>,
        ]}
      />
      <SubHeading>Both sides surfaced</SubHeading>
      <P>
        For every bucket the protocol returns{" "}
        <Code>(mint_cost, redeem_payout)</Code> — the ask you pay to mint at
        this size and the bid you would receive redeeming it now. Pelagos
        surfaces both, plus derived deltas:
      </P>
      <UL
        items={[
          <><Code>mint_cost</Code> — ask at quantity (spread + slippage included).</>,
          <><Code>redeem_value</Code> — bid at quantity (the redeem-now payout).</>,
          <><Code>slippage</Code> — <Code>mint_cost − unit_price·qty</Code>, the convexity over the marginal price.</>,
          <><Code>spread</Code> — <Code>mint_cost − redeem_value</Code>, the round-trip MM spread at this size.</>,
          <><Code>expected_value</Code> — EV under the user&apos;s own Normal view.</>,
        ]}
      />
      <SubHeading>The [2%, 98%] mintable band</SubHeading>
      <P>
        The pricer will happily quote bands outside the protocol&apos;s mint
        bounds (≈[1%, 99%]), so they look tradeable — but{" "}
        <Code>mint_range</Code> then aborts in{" "}
        <Code>assert_mintable_ask</Code>. To guarantee that every bucket
        Pelagos surfaces as tradeable actually mints, a bucket is flagged
        tradeable only when its marginal ask sits inside{" "}
        <Code>[0.02, 0.98]</Code> — a deliberate safety margin inside the
        protocol bound so post-trade slippage cannot push it out. Out-of-band
        and failing buckets are skipped, never faked.
      </P>
      <P>
        Verified live: a binary preview on an ATM oracle returned UP $0.509 /
        DOWN $0.508, summing to $1.017 — the spread the PLP earns.
      </P>
    </>
  );
}

function DbpOracle() {
  return (
    <>
      <P>
        DeepBook Predict prices against a BTC <B>SVI vol-surface oracle</B>.
        Pelagos reads the live surface and forward directly from the
        protocol, so every strike, probability, and greek is grounded in the
        same source the protocol settles against.
      </P>
      <SubHeading>SVI surface</SubHeading>
      <P>
        The backend exposes the live surface at{" "}
        <Code>GET /api/predict/vol-surface</Code> and an implied density at{" "}
        <Code>GET /api/predict/density</Code>. The Advanced{" "}
        <DocLink href="/app/volatility">Volatility</DocLink> desk renders this
        as an interactive 3D surface with smile and term-structure analytics;
        greeks are computed off the same smile rather than a flat-vol
        assumption.
      </P>
      <SubHeading>Rolling BTC expiries</SubHeading>
      <P>
        The protocol publishes a ladder of BTC oracles across expiries, from
        roughly fifteen minutes out to about twenty-two days. Pelagos reads
        the active set from <Code>GET /api/predict/oracles</Code> and snaps a
        requested strike to the nearest on-grid level via the indexer. The{" "}
        <DocLink href="/app/distribution">Distributed Options</DocLink> chain
        renders calls and puts across every live expiry; expiring oracles
        drop off and new ones appear as the protocol rolls them.
      </P>
      <SubHeading>Settlement</SubHeading>
      <P>
        Settlement is native to DeepBook Predict. While a market is live a
        holder can redeem at the current bid via{" "}
        <Code>redeem_range</Code>; once the oracle settles, anyone can claim
        a winning range permissionlessly. Pelagos does not adjudicate or
        override resolution — it reads and submits against the protocol.
      </P>
    </>
  );
}

function DbpStrip() {
  return (
    <>
      <P>
        The range strip is the single primitive every Pelagos product is
        parameterised from. A strip is N on-grid Predict ranges, weighted by
        a Normal(μ, σ) mass, that together reproduce a distributional payoff.
      </P>
      <SubHeading>Anatomy of a strip quote</SubHeading>
      <CodeBlock>
        {`view        Normal(μ, σ)            direction μ, width σ
buckets     N on-grid ranges        ±spanSigma·σ, non-overlapping
weight[i]   Φ(hi)−Φ(lo)             Normal mass of bucket i
qty[i]      ∝ weight[i]             sized so payout mirrors the view
cost[i]     get_range_trade_amounts priced at qty[i], post-trade state
strip       Σ cost[i]  ≈  budget    one budget correction if >5% off`}
      </CodeBlock>
      <SubHeading>How each product re-parameterises it</SubHeading>
      <Table
        cols={["Product", "Strip parameterisation"]}
        rows={[
          ["Distribution", "μ/σ chosen directly on sliders; N buckets across the view."],
          ["Risk Slices", "Same μ; width fixed per slice — senior 0.5σ, mezzanine 1.0σ, junior 2.0σ."],
          ["Protected Notes", "Upside sleeve is a strip; floor sleeve is supplied to the PLP vault instead of minted."],
          ["DeepBook baskets", "Named μ/σ presets — BTC Pin (0.3%σ, n4), BTC Spread (0.6%σ, n6), BTC Wide (1.0%σ, n8)."],
          ["Volatility", "Multi-leg strips composed into straddle / strangle / butterfly / iron condor."],
        ]}
      />
      <SubHeading>One signature</SubHeading>
      <P>
        A whole strip mints in a single programmable transaction block: an
        optional <Code>create_manager</Code>, a dUSDC deposit, and{" "}
        <Code>N × mint_range</Code> — all bundled and signed once. The same
        applies to a Protected Note, where the PLP supply and the range strip
        share one PTB.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — Products
// ---------------------------------------------------------------------------

function PDistributed() {
  return (
    <>
      <P>
        Distributed Options is a live BTC options chain. Every strike is a
        DeepBook Predict range with a $1 binary payout, priced live off the
        protocol&apos;s own bid/ask. Contracts are whole, depth- and
        risk-capped per strike, and settled on Sui.
      </P>
      <SubHeading>The chain</SubHeading>
      <P>
        Calls and puts are laid out across every on-chain expiry, from
        roughly fifteen minutes to about twenty-two days. Each strike shows
        the live ask and bid, the implied volatility from the SVI smile, and a
        per-strike depth cap so an order can never exceed what is actually
        mintable. The chain is served by{" "}
        <Code>GET /api/options/chain</Code> with per-strike depth at{" "}
        <Code>GET /api/options/depth</Code>.
      </P>
      <SubHeading>Buying a contract</SubHeading>
      <OL
        items={[
          <>Open <DocLink href="/app/distribution">Distributed Options</DocLink> and pick an expiry and strike.</>,
          <>Choose call or put and a contract count. The quote shows ask, IV, and the depth-capped maximum.</>,
          <>Confirm. The wallet signs a single PTB that mints the underlying range against dUSDC.</>,
          <>Hold to settlement for the binary payout, or redeem early at the live bid.</>,
        ]}
      />
      <SubHeading>Why it is honest</SubHeading>
      <P>
        Because each strike is a real Predict range, the price the chain
        shows is the price the protocol charges — including the MM spread and
        the slippage the order itself adds. There is no synthetic AMM and no
        invented mark.
      </P>
    </>
  );
}

function PVolatility() {
  return (
    <>
      <P>
        The Volatility desk trades implied versus realized vol with prebuilt
        structures: straddle, strangle, butterfly, and iron condor. Each is a
        multi-leg composition of range strips, with a live payoff diagram,
        full greeks, and an optional delta-hedge sleeve.
      </P>
      <SubHeading>Basic and Advanced</SubHeading>
      <P>
        Basic presents the prebuilt structures with a payoff diagram and a
        one-click open. Advanced adds an interactive{" "}
        <B>3D SVI vol surface</B>, smile and term-structure analytics, and a
        multi-leg trade builder for composing custom structures. Both read the
        same live surface and price the same way.
      </P>
      <SubHeading>Greeks and hedging</SubHeading>
      <P>
        Greeks are computed off the live SVI smile rather than a flat-vol
        assumption, so delta, gamma, vega, and theta reflect the actual
        surface the protocol settles against. The hedge sleeve sizes a
        delta-neutralising leg, surfaced at{" "}
        <Code>GET /api/vol/hedge</Code>.
      </P>
      <SubHeading>Routes</SubHeading>
      <UL
        items={[
          <><Code>GET /api/vol/surface</Code> — the live SVI surface for the desk.</>,
          <><Code>POST /api/vol/quote</Code> — price a structure and return greeks + payoff.</>,
          <><Code>POST /api/vol/open/prepare</Code> — unsigned multi-leg open for the wallet to sign.</>,
        ]}
      />
    </>
  );
}

function PDistribution() {
  return (
    <>
      <P>
        Distribution Markets expose the range ladder directly. A user shapes a
        continuous view — a mean μ and a width σ — and Pelagos mints it as N
        weighted Predict range buckets that reproduce the payoff. This is the
        raw form of the engine every other product specialises.
      </P>
      <SubHeading>Flow</SubHeading>
      <OL
        items={[
          <>
            Drag μ (direction) and σ (conviction) on the{" "}
            <DocLink href="/app/distribution">Distribution</DocLink> sliders;
            set a budget and bucket count N.
          </>,
          <>
            The preview calls <Code>POST /api/predict/strip/preview</Code>,
            which returns N on-grid buckets priced live off the protocol, with
            per-bucket ask, bid, slippage, and the strip totals.
          </>,
          <>
            Confirm. <Code>POST /api/predict/strip/open/prepare</Code> returns
            an unsigned <Code>deposit + N × mint_range</Code> PTB; the wallet
            signs it in one signature.
          </>,
          <>
            Redeem live via <Code>range/redeem/prepare</Code>, or
            permissionlessly once the oracle settles.
          </>,
        ]}
      />
      <SubHeading>What the quote tells you</SubHeading>
      <P>
        Because the strip is priced at real quantity against post-trade vault
        state, the quote surfaces the true cost of expressing the view: total
        cost, max payout, total slippage, round-trip spread, and the expected
        value under the user&apos;s own Normal. Out-of-band buckets (outside
        the <Code>[2%, 98%]</Code> mintable band) are shown as untradeable
        rather than silently dropped.
      </P>
    </>
  );
}

function PSlices() {
  return (
    <>
      <P>
        Risk Slices express a risk appetite over the same underlying view.
        Senior, mezzanine, and junior are the same strip taken at different
        widths: a narrow ATM slice is high hit-rate and low multiple, a wide
        slice is convex, low hit-rate, and high multiple.
      </P>
      <Table
        cols={["Slice", "Strip width", "Profile"]}
        rows={[
          ["Senior", "0.5σ", "Narrow, around the mean. High probability of paying, modest multiple. Resembles an investment-grade claim."],
          ["Mezzanine", "1.0σ", "Mid-width. Balanced hit-rate and multiple. Resembles a call spread."],
          ["Junior", "2.0σ", "Wide tails. Low hit-rate, convex payout. Resembles a deep out-of-the-money option."],
        ]}
      />
      <SubHeading>Pricing</SubHeading>
      <P>
        Each slice is quoted through{" "}
        <Code>POST /api/predict/tranche/quote</Code>, which prices the
        corresponding strip width against live Predict liquidity. The
        Advanced <DocLink href="/app/basket">Baskets</DocLink> surface
        renders the three slices side by side with their live quotes so the
        seniority trade-off is legible at a glance.
      </P>
      <SubHeading>Settlement</SubHeading>
      <P>
        Slices settle exactly like any other strip: each constituent range
        redeems at its binary payout, and the slice pays the weighted sum.
        There is no separate waterfall contract — the seniority is encoded in
        which part of the distribution the strip covers.
      </P>
    </>
  );
}

function PNotes() {
  return (
    <>
      <P>
        A Protected Note pairs a principal floor with capped upside. The floor
        sleeve is supplied to DeepBook Predict&apos;s PLP vault — the
        &quot;be the house&quot; side that earns the spread Pelagos quotes
        elsewhere — and the upside sleeve is a range strip. Both legs settle
        in one programmable transaction block.
      </P>
      <SubHeading>How the split works</SubHeading>
      <UL
        items={[
          <>
            <B>Floor sleeve.</B> A chosen fraction of the deposit (default
            <Code>floor_pct = 0.8</Code>) is supplied to the PLP vault via{" "}
            <Code>predict::supply</Code>, earning the protocol&apos;s
            counterparty yield.
          </>,
          <>
            <B>Upside sleeve.</B> The remainder buys a range strip expressing
            the user&apos;s view, carrying the convex upside.
          </>,
          <>
            <B>One PTB.</B> The deposit split, PLP supply, and range mint are
            bundled by <Code>POST /api/predict/ppn/open/prepare</Code> and
            signed once.
          </>,
        ]}
      />
      <SubHeading>Floor sourcing</SubHeading>
      <P>
        The note&apos;s yield context is surfaced from real Sui USDC lending
        venues (via DeFiLlama) so the floor target is grounded in live rates,
        not a fixed assumption. Live PLP vault state — NAV, share price,
        utilisation — is readable at{" "}
        <Code>GET /api/predict/vault/summary</Code>. The prebuilt strategies
        and the note builder live on the{" "}
        <DocLink href="/app/deepbook">DeepBook</DocLink> surface.
      </P>
      <SubHeading>Honest floor</SubHeading>
      <P>
        Principal protection is a target, not a guarantee. It depends on PLP
        vault solvency, redemption availability, and settlement timing — see{" "}
        the risk summary. The floor is the protocol&apos;s counterparty
        position, so it carries the risks of being the house.
      </P>
    </>
  );
}

function PBaskets() {
  return (
    <>
      <P>
        Baskets come in two flavours: curated DeepBook range recipes and
        diversified Polymarket event baskets. They share the basket terminal
        but sit on different settlement rails.
      </P>
      <SubHeading>DeepBook baskets</SubHeading>
      <P>
        One-click μ/σ presets over the live BTC oracle, each a range strip:
        <Code>BTC Pin</Code> (0.3%σ, n4), <Code>BTC Spread</Code> (0.6%σ, n6),
        and <Code>BTC Wide</Code> (1.0%σ, n8). They are quoted through{" "}
        <Code>GET /api/predict/baskets</Code> and{" "}
        <Code>POST /api/predict/basket/quote</Code> and settle in dUSDC on
        DeepBook Predict.
      </P>
      <SubHeading>Polymarket event baskets</SubHeading>
      <P>
        Diversified baskets of Polymarket events, priced off the live CLOB
        midpoint. An NLP layer (TF-IDF cosine plus theme clustering)
        de-correlates the legs so a basket is genuinely uncorrelated rather
        than thirty variants of one bet. These settle on Pelagos&apos;s own
        generic <Code>Vault&lt;T&gt;</Code> in Pelagos USDC, kept distinct
        from the Predict-backed suite so demos are never bottlenecked on the
        dUSDC faucet.
      </P>
      <SubHeading>Risk Slices in Advanced</SubHeading>
      <P>
        The Basic <DocLink href="/app/basket">Baskets</DocLink> view is a
        clean basket terminal; Advanced is the{" "}
        <DocLink href="/app/basket">Risk Slices</DocLink> tranching engine,
        rendering senior, mezzanine, and junior on the same basket. The
        5-stage NLP quality filter behind the event legs is documented in the
        repository&apos;s market-filter writeup.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — Settlement rails
// ---------------------------------------------------------------------------

function RailsOverview() {
  return (
    <>
      <P>
        Pelagos has two settlement rails, both first-class, both 1:1 in USD.
        Which one an order uses depends on the product: anything that touches
        DeepBook Predict settles in dUSDC; Pelagos&apos;s own contracts settle
        in Pelagos USDC.
      </P>
      <Table
        cols={["Rail", "Asset", "Mintable?", "Used for"]}
        rows={[
          [
            "DeepBook Predict",
            "dUSDC — the protocol&apos;s quote asset (6 dp).",
            "Faucet-gated. TreasuryCap is Mysten&apos;s; we hold a float only.",
            "Distribution strips, Risk Slices, Protected Note floors and upside, DeepBook baskets.",
          ],
          [
            "Pelagos vault",
            "Pelagos USDC (MOCK_USDC, 6 dp).",
            "Freely mintable via a shared, permissionless Faucet (≤1,000,000/call).",
            "Polymarket event baskets and Pelagos&apos;s own Vault flows.",
          ],
        ]}
      />
      <SubHeading>Why two rails</SubHeading>
      <P>
        dUSDC is the only asset DeepBook Predict accepts — registering a quote
        asset requires the protocol&apos;s AdminCap, which Pelagos does not
        hold. So the Predict-backed suite is honestly collateralised in the
        protocol&apos;s real asset. dUSDC is faucet-gated and not mintable by
        us, which makes it the one hard blocker for live writes. To keep the
        rest of the app frictionlessly testable, Pelagos&apos;s own contracts
        use a freely-mintable Pelagos USDC so a demo never bottlenecks on the
        dUSDC faucet.
      </P>
      <SubHeading>Getting test funds</SubHeading>
      <P>
        The header <B>Test funds</B> button, shown when a wallet is connected,
        sends 25 dUSDC (from the operator float) and 10,000 Pelagos USDC
        (freshly minted) in one click. Each Predict surface also shows a
        contextual <B>Get test dUSDC</B> when the wallet is short. Gas (SUI) is
        free from the standard Sui testnet faucet.
      </P>
      <SubHeading>A note on DEEP</SubHeading>
      <P>
        DeepBook Predict is an AMM/PLP-backed range protocol that settles
        purely in dUSDC. It does <B>not</B> use DEEP — that is DeepBook v3&apos;s
        CLOB fee token, and Pelagos places no v3 CLOB orders. A live range
        mint consumes zero DEEP, only dUSDC and SUI gas.
      </P>
    </>
  );
}

function RailsLifecycle() {
  return (
    <>
      <P>
        However it is parameterised, a Pelagos position follows the same
        lifecycle from quote to settlement. The Predict-backed path is shown
        below; the vault-backed event-basket path mirrors it through the
        sim/deposit routes on the Pelagos USDC rail.
      </P>
      <OL
        items={[
          <>
            <B>Quote.</B> A μ/σ view (or a structure, slice, or basket
            preset) is priced live off the protocol&apos;s own{" "}
            <Code>get_range_trade_amounts</Code>. The quote shows ask, bid,
            slippage, spread, and expected value at the real order size.
          </>,
          <>
            <B>Prepare.</B> The backend builds an unsigned PTB — on a first
            open, bundling <Code>create_manager</Code>, the dUSDC deposit, and{" "}
            <Code>N × mint_range</Code> — and dry-runs it for a gas estimate.
          </>,
          <>
            <B>Sign.</B> The wallet signs the bytes. The user&apos;s wallet
            owns the resulting <Code>PredictManager</Code>.
          </>,
          <>
            <B>Confirm.</B> The executed digest is posted to{" "}
            <Code>/confirm</Code>, which verifies it on chain and records the
            position. It now shows in the{" "}
            <DocLink href="/app/portfolio">Portfolio</DocLink> with live
            mark-to-market.
          </>,
          <>
            <B>Redeem or settle.</B> Redeem early at the live bid via{" "}
            <Code>range/redeem</Code>, or hold to settlement and claim the
            binary payout permissionlessly once the oracle resolves.
          </>,
        ]}
      />
      <SubHeading>Mark-to-market</SubHeading>
      <P>
        While a position is open, its mark is the live redeem-now value of its
        constituent ranges — the same bid the protocol would pay, read off
        chain. The Portfolio surface aggregates this across products into a
        single P&amp;L.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — On-chain
// ---------------------------------------------------------------------------

function ChainPackages() {
  return (
    <>
      <P>
        Pelagos deploys three Move packages to Sui testnet and calls a fourth
        — Mysten&apos;s DeepBook Predict — which it does not deploy.
      </P>
      <Table
        cols={["Package", "Modules", "Role"]}
        rows={[
          [
            "pelagos_sui",
            "mock_usdc, prediction_market",
            "Freely-mintable test collateral (Pelagos USDC) plus binary prediction markets.",
          ],
          [
            "pelagos_vault",
            "vault",
            "A generic Vault&lt;T&gt; with a NAV share-price; backs event baskets and Predict-backed wrappers.",
          ],
          [
            "pelagos_strategies",
            "structured_note",
            "A principal-protection floor primitive plus admin settlement.",
          ],
          [
            "DeepBook Predict (Mysten)",
            "predict, predict_manager, PLP vault, OracleSVI",
            "The on-chain range markets Pelagos prices against and settles on. Called, not deployed.",
          ],
        ]}
      />
      <SubHeading>How they fit together</SubHeading>
      <UL
        items={[
          <>
            Every option and strategy leg is priced against DeepBook
            Predict&apos;s real liquidity via{" "}
            <Code>get_range_trade_amounts</Code> and settled natively on it.
          </>,
          <>
            <Code>pelagos_vault</Code> provides a NAV-share <Code>Vault&lt;T&gt;</Code>:
            a <Code>Vault&lt;MOCK_USDC&gt;</Code> backs the event baskets and a{" "}
            <Code>Vault&lt;dUSDC&gt;</Code> backs Predict wrappers.
          </>,
          <>
            <Code>pelagos_sui</Code> mints Pelagos USDC through a shared,
            permissionless Faucet and runs the local binary prediction
            markets used by event baskets.
          </>,
        ]}
      />
      <SubHeading>Hand-rolled PTBs</SubHeading>
      <P>
        Pelagos calls the live Predict package directly through hand-rolled
        programmable transaction blocks: <Code>create_manager</Code>,{" "}
        <Code>deposit</Code>, <Code>mint</Code> / <Code>redeem</Code>,{" "}
        <Code>mint_range</Code> / <Code>redeem_range</Code>,{" "}
        <Code>supply</Code> / <Code>withdraw</Code>, and the{" "}
        <Code>get_trade_amounts</Code> / <Code>get_range_trade_amounts</Code>{" "}
        previews — all against dUSDC, the protocol&apos;s quote asset.
      </P>
    </>
  );
}

function ChainDeploy() {
  return (
    <>
      <P>
        Live on Sui testnet, chain <Code>4c78adac</Code>, deployed under a
        dedicated operator wallet. The canonical IDs and verified on-chain
        digests live in <Code>DEPLOYMENT.md</Code>; the headline objects are
        below.
      </P>
      <SubHeading>Pelagos packages</SubHeading>
      <Table
        cols={["Object", "ID"]}
        rows={[
          ["pelagos_sui package", "0x598434be…3e45"],
          ["mock_usdc::Faucet (shared)", "0xd1f67a0e…a07f0"],
          ["pelagos_vault package", "0xcaff49f8…2e2b19"],
          ["Vault&lt;MOCK_USDC&gt; (shared)", "0x5fdc7d7a…042d2d"],
          ["Vault&lt;dUSDC&gt; (shared)", "0x9110df66…68c54a"],
        ]}
      />
      <SubHeading>DeepBook Predict (Mysten)</SubHeading>
      <Table
        cols={["Object", "ID"]}
        rows={[
          ["Predict package", "0xf5ea2b37…785138"],
          ["Predict object (market root)", "0xc8736204…38028a"],
          ["dUSDC type", "0xe9504008…73e1a::dusdc::DUSDC"],
          ["Indexer", "predict-server.testnet.mystenlabs.com"],
        ]}
      />
      <SubHeading>Verified end-to-end</SubHeading>
      <P>
        Both Pelagos packages publish with green Move tests. Live, on-chain,
        wallet-signed digests this deploy include a one-PTB range-strip mint,
        a PLP supply for a note floor, and a range mint and redeem in both
        directions. The indexer corroborates four range mints and one redeem.
        Every wallet-signed build dry-runs clean on chain, and a fresh
        mint→redeem cycle confirms the live path on current code. Full digests
        are in <Code>DEPLOYMENT.md</Code>.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — Developers
// ---------------------------------------------------------------------------

function DevApi() {
  return (
    <>
      <P>
        All frontend data and on-chain orchestration flow through the backend
        under <Code>backend/</Code>. The base URL is configured via{" "}
        <Code>NEXT_PUBLIC_BACKEND_URL</Code> (default{" "}
        <Code>http://localhost:13101</Code>). Reads run through{" "}
        <Code>devInspect</Code> — no funds, no signer. Writes are returned as
        unsigned <Code>tx_bytes</Code> for the wallet to sign.
      </P>
      <SubHeading>Predict — reads (no funds)</SubHeading>
      <Endpoint
        method="GET"
        path="/api/predict/oracles"
        description="Active BTC oracles across expiries. Filters: ?active=true, ?underlying=BTC."
        params={[
          ["active", "bool", "Default true."],
          ["underlying", "string", "Default BTC."],
        ]}
        responseNote="{ oracles: Oracle[] }"
      />
      <Endpoint
        method="GET"
        path="/api/predict/vol-surface"
        description="Live SVI vol surface for the Volatility desk and greeks."
        params={[]}
        responseNote="{ surface, smile, term_structure }"
      />
      <Endpoint
        method="GET"
        path="/api/predict/vault/summary"
        description="Live PLP vault summary — NAV, share price, utilisation. The 'vault strategy' behind Protected Note floors."
        params={[]}
        responseNote="{ nav, share_price, utilization }"
      />
      <SubHeading>Predict — pricing (the core preview)</SubHeading>
      <Endpoint
        method="POST"
        path="/api/predict/strip/preview"
        description="μ/σ view → N on-grid range buckets, live MM-priced off get_range_trade_amounts. Surfaces ask, bid, slippage, spread, and EV per bucket and as strip totals."
        params={[
          ["asset", "string", "Default BTC; or oracle_id directly."],
          ["mu_usd", "number", "View mean (or mu_raw, 1e9)."],
          ["sigma_usd", "number", "View width (or sigma_raw, 1e9)."],
          ["budget_usd", "number", "Total spend (or budget_raw, 6dp)."],
          ["n", "number", "Bucket count."],
        ]}
        responseNote="{ buckets: PricedBucket[], totals: StripQuote }"
      />
      <SubHeading>Predict — structured products (non-custodial)</SubHeading>
      <Endpoint
        method="POST"
        path="/api/predict/strip/open/prepare"
        description="Unsigned deposit + N × mint_range PTB (one signature). Bundles create_manager on a first open."
        params={[
          ["asset", "string", "Or oracle_id."],
          ["mu_usd", "number", "View mean."],
          ["sigma_usd", "number", "View width."],
          ["budget_usd", "number", "Total spend."],
          ["n", "number", "Bucket count."],
        ]}
        responseNote="{ tx_bytes, sender, dry_run }"
      />
      <Endpoint
        method="POST"
        path="/api/predict/ppn/open/prepare"
        description="Unsigned single-PTB Protected Note open: split → PLP supply (floor) + deposit + range strip (upside)."
        params={[
          ["budget_usd", "number", "Total deposit."],
          ["floor_pct", "number", "Floor fraction; default 0.8."],
          ["mu_usd", "number", "Upside view mean."],
          ["sigma_usd", "number", "Upside view width."],
        ]}
        responseNote="{ tx_bytes, sender, dry_run }"
      />
      <Endpoint
        method="POST"
        path="/api/predict/tranche/quote"
        description="Senior / mezzanine / junior Risk Slice quotes — the same strip at 0.5σ / 1σ / 2σ."
        params={[
          ["asset", "string", "Or oracle_id."],
          ["budget_usd", "number", "Per-slice budget."],
        ]}
        responseNote="{ senior, mezzanine, junior }"
      />
      <Endpoint
        method="POST"
        path="/api/predict/confirm"
        description="Verify a wallet-executed digest on chain. Surfaces emitted events and any newly created manager id."
        params={[["digest", "string", "The executed transaction digest."]]}
        responseNote="{ ok, events, manager_id? }"
      />
      <SubHeading>Other product surfaces</SubHeading>
      <Endpoint
        method="GET"
        path="/api/options/chain"
        description="The BTC options chain — calls and puts across every live expiry, each priced off Predict range liquidity with IV from the SVI smile and a per-strike depth cap."
        params={[["asset", "string", "Default BTC."]]}
        responseNote="{ expiries: Expiry[], strikes: Strike[] }"
      />
      <Endpoint
        method="POST"
        path="/api/vol/quote"
        description="Price a vol structure (straddle / strangle / butterfly / iron condor) and return greeks + payoff."
        params={[["structure", "string", "The structure id."], ["budget_usd", "number", "Total spend."]]}
        responseNote="{ legs, greeks, payoff }"
      />
      <Endpoint
        method="GET"
        path="/api/predict/baskets"
        description="The named DeepBook structured baskets (BTC Pin / Spread / Wide)."
        params={[]}
        responseNote="{ baskets: Basket[] }"
      />
      <SubHeading>Conventions</SubHeading>
      <UL
        items={[
          <>
            Bodies accept raw or human amounts: <Code>*_raw</Code> (u64
            string, 6dp/1e9) or <Code>*_ui</Code> (<Code>budget_usd</Code>,{" "}
            <Code>mu_usd</Code>, <Code>sigma_usd</Code>, …).
          </>,
          <>
            The server resolves a valid on-grid oracle by{" "}
            <Code>oracle_id</Code> or by <Code>asset</Code> (default BTC) and
            reads the live forward.
          </>,
          <>
            Errors return <Code>{`{ error: string }`}</Code> with an
            appropriate HTTP status. Health is at{" "}
            <Code>GET /api/health</Code>; the monitor runs on{" "}
            <Code>:13102</Code>.
          </>,
        ]}
      />
    </>
  );
}

function DevRepo() {
  return (
    <>
      <P>
        The repository is a monorepo: a Next.js frontend, an Express backend,
        and three Move packages, each independently buildable.
      </P>
      <CodeBlock>
        {`app/                 Next.js frontend (forked; app dir = app/app/)
backend/             Express engine (pricing, PTB builders, proxies)
pelagos_sui/         Move: mock_usdc + prediction_market
pelagos_vault/       Move: generic Vault<T>
pelagos_strategies/  Move: structured_note`}
      </CodeBlock>
      <SubHeading>Frontend layout</SubHeading>
      <CodeBlock>
        {`app/app/
  page.tsx              // Landing
  distribution/         // Distributed Options + range ladder
  volatility/           // Vol structures, SVI surface, builder
  deepbook/             // Prebuilt range strategies + Protected Notes
  basket/               // DeepBook recipes + Polymarket event baskets
  tranche/  ppn/        // Risk Slices + Notes (deep-link routes)
  portfolio/            // Holdings, mark-to-market, P&L, backtests
  docs/                 // This About & docs surface
  _components/          // Header, shared layout
  _lib/                 // tokens, clients, mode/theme, strip math`}
      </CodeBlock>
      <SubHeading>Backend layout</SubHeading>
      <CodeBlock>
        {`backend/src/
  index.ts              // Express wiring, ~30 /api/* route groups
  routes/
    predict.ts          // /api/predict/* (core engine)
    options.ts          // /api/options/chain · /depth
    vol.ts              // /api/vol/*
    distribution.ts     // /api/distribution/*
    deepbook.ts ppn.ts vaults.ts ...
  services/
    predict/            // SVI surface, strip math, PTB builders
    options-chain/  volatility/  baskets/  vault/  sui/ ...`}
      </CodeBlock>
      <SubHeading>Forked Next.js</SubHeading>
      <P>
        The frontend is a <B>forked</B> Next.js with non-standard
        conventions — the app directory is <Code>app/app/</Code>. Read{" "}
        <Code>AGENTS.md</Code> and <Code>node_modules/next/dist/docs/</Code>{" "}
        before touching frontend code.
      </P>
      <SubHeading>Run and verify</SubHeading>
      <CodeBlock>
        {`# backend (:13101) + monitor (:13102)
cd backend && npm install && npm run dev
# frontend (:13100) — in another shell
npm run dev

# typecheck + Move tests
(cd app && npx tsc --noEmit)
(cd backend && npx tsc --noEmit)
(cd pelagos_strategies && sui move test)`}
      </CodeBlock>
      <P>
        Configure the backend host via <Code>NEXT_PUBLIC_BACKEND_URL</Code> in{" "}
        <Code>app/.env.local</Code>. Pricing, previews, and simulations need
        no paid credentials and no funds; only live writes need dUSDC.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — Risks
// ---------------------------------------------------------------------------

function RiskSummary() {
  return (
    <>
      <P>
        The risks below describe how the protocol would behave with real
        capital. The current deployment is on Sui testnet and exposes no real
        value to any of them; they are documented because any
        structured-products surface should disclose the loss paths inherent to
        its design.
      </P>
      <SubHeading>Directional risk</SubHeading>
      <P>
        A strip is a leveraged expression of a view on where an asset lands. If
        BTC settles outside the range mass the position pays little or
        nothing. A narrow ATM slice has a high hit-rate but small multiple; a
        wide junior slice is convex and frequently expires worthless.
      </P>
      <P>
        <B>Scenario.</B> A junior (2.0σ) slice is minted for a sharp move. BTC
        settles near the forward, inside the senior band but outside the
        junior tails. The junior position pays zero even though a senior slice
        on the same view would have paid in full.
      </P>
      <SubHeading>Liquidity and slippage risk</SubHeading>
      <P>
        Every bucket is priced against post-trade vault state, so a large
        order pays the slippage of the liability it adds. The{" "}
        <Code>[2%, 98%]</Code> mintable band means buckets near the edges of
        the distribution can become untradeable; size that exceeds available
        depth is rejected rather than filled at a fictional price.
      </P>
      <SubHeading>PLP / floor risk (Protected Notes)</SubHeading>
      <P>
        A note&apos;s floor sleeve is supplied to the PLP vault as the
        protocol&apos;s counterparty — the &quot;be the house&quot; side.
        Principal protection is a target, not a guarantee: it depends on PLP
        vault solvency, redemption availability, and settlement timing. A loss
        on the house side, or a withdrawal delay around maturity, impairs the
        floor.
      </P>
      <SubHeading>Oracle and settlement risk</SubHeading>
      <P>
        Settlement follows DeepBook Predict&apos;s SVI oracle. Pelagos does
        not adjudicate or override resolution; an oracle fault or a delayed
        settlement propagates to every position referencing the affected
        market.
      </P>
      <SubHeading>Smart-contract risk</SubHeading>
      <P>
        A live deployment carries the standard risks of on-chain programs:
        bugs in settlement logic, upgrade-authority compromise, and
        integration errors. The Pelagos packages target testnet and have not
        been audited. DeepBook Predict is Mysten&apos;s code, called as-is.
      </P>
      <SubHeading>Operational risk</SubHeading>
      <P>
        Backend outages freeze quote generation and the prepare step until
        service is restored. Reads degrade to the most recent cached snapshot,
        which may be stale relative to the live oracle.
      </P>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages — FAQ
// ---------------------------------------------------------------------------

function FaqAll() {
  return (
    <>
      <Faq
        q="Is real capital used in the application?"
        a="No. Pelagos runs on Sui testnet — every balance is a testnet token with no monetary value, including both dUSDC and Pelagos USDC. Pricing and settlement are live off real DeepBook Predict liquidity, but no real capital is routed through the protocol."
      />
      <Faq
        q="Will the protocol be deployed to mainnet?"
        a="No. The repository will remain available as a reference, but there are no plans to deploy to mainnet, issue a token, or continue maintenance after the hackathon."
      />
      <Faq
        q="What is DeepBook Predict and what does Pelagos add?"
        a="DeepBook Predict is Mysten's on-chain prediction protocol — it exposes binary and range options over a BTC SVI oracle. Pelagos calls it (does not deploy it) and adds a structured-product layer: a range-strip engine that turns a continuous μ/σ view into a basket of real range-options minted in one signature."
      />
      <Faq
        q="Where do the prices come from?"
        a="Every bucket price comes from the protocol's own get_range_trade_amounts via devInspect, priced at the actual order quantity against post-trade vault state. Nothing on the pricing path is invented or linearly interpolated — the quote already includes the MM spread and the order's own slippage."
      />
      <Faq
        q="Is Pelagos custodial?"
        a="No. The backend builds unsigned programmable transaction blocks; the user's wallet signs and executes them, and the user's wallet owns the on-chain PredictManager that gates mint and redeem. The backend never holds user keys or collateral on the structured-product path."
      />
      <Faq
        q="Why are there two USDC tokens?"
        a="dUSDC is the only asset DeepBook Predict accepts, so anything settling on Predict uses it — but it is faucet-gated and not mintable by us. Pelagos USDC (MOCK_USDC) is freely mintable and backs Pelagos's own contracts (Polymarket event baskets, vault flows), so a demo never bottlenecks on the dUSDC faucet. Both are 1:1 in USD and first-class."
      />
      <Faq
        q="How do I get test funds?"
        a="The header 'Test funds' button (shown when a wallet is connected) sends 25 dUSDC plus 10,000 Pelagos USDC in one click. Each Predict surface also shows a contextual 'Get test dUSDC' when the wallet is short. Gas (SUI) is free from the standard Sui testnet faucet."
      />
      <Faq
        q="Does Pelagos use DEEP?"
        a="No. DeepBook Predict is an AMM/PLP-backed range protocol that settles purely in dUSDC. DEEP is DeepBook v3's CLOB fee token; Pelagos places no v3 CLOB orders, and a live range mint consumes zero DEEP — only dUSDC and SUI gas."
      />
      <Faq
        q="What is the range strip, exactly?"
        a="A set of adjacent, on-grid DeepBook Predict ranges weighted by a Normal(μ, σ) mass. Together they reproduce a distributional payoff. Every Pelagos product — Distribution, Risk Slices, Protected Notes, DeepBook baskets, Volatility — is the same strip engine with a different parameterisation."
      />
      <Faq
        q="What are Risk Slices?"
        a="The same underlying strip taken at three widths: senior 0.5σ, mezzanine 1.0σ, junior 2.0σ. Narrow is high hit-rate and low multiple; wide is convex, low hit-rate, and high multiple. Seniority is encoded in which part of the distribution the strip covers."
      />
      <Faq
        q="How is a Protected Note's floor produced?"
        a="A chosen fraction of the deposit (default 80%) is supplied to DeepBook Predict's PLP vault — the 'be the house' side that earns the spread — and the remainder buys a range strip for upside. Both legs settle in one PTB. The floor is a target, not a guarantee: it depends on PLP solvency and redemption availability."
      />
      <Faq
        q="What is the [2%, 98%] mintable band?"
        a="The pricer will quote bands outside the protocol's mint bounds, which would then abort in assert_mintable_ask. So Pelagos only flags a bucket tradeable when its marginal ask sits inside [0.02, 0.98] — a safety margin inside the protocol's ~[1%, 99%] so post-trade slippage can't push a surfaced bucket out of bounds."
      />
      <Faq
        q="Which BTC expiries are available?"
        a="The protocol publishes a rolling ladder of BTC oracles, from roughly fifteen minutes out to about twenty-two days. Pelagos reads the active set live; expiring oracles drop off and new ones appear as the protocol rolls them."
      />
      <Faq
        q="Can I close a position before settlement?"
        a="Yes. A range can be redeemed at the live bid via range/redeem while the market is open. Once the oracle settles, a winning range can be claimed permissionlessly. The Portfolio surface marks open positions to the live redeem-now value."
      />
      <Faq
        q="Where can I verify it actually works on chain?"
        a="DEPLOYMENT.md lists the live testnet package and object IDs plus verified wallet-signed digests — a one-PTB range-strip mint, a PLP supply, and a range mint and redeem — corroborated by the Predict indexer. Every build also dry-runs clean on chain before signing."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Typography primitives
// ---------------------------------------------------------------------------

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontFamily: FD,
        fontSize: 16,
        fontWeight: 600,
        letterSpacing: "-0.005em",
        lineHeight: 1.3,
        margin: 0,
        marginTop: 28,
        marginBottom: 10,
        color: C.textPrimary,
      }}
    >
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        marginBottom: 14,
        color: C.textSecondary,
        lineHeight: 1.75,
        fontSize: 14.5,
      }}
    >
      {children}
    </p>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return (
    <strong style={{ color: C.textPrimary, fontWeight: 600 }}>{children}</strong>
  );
}

function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        color: C.tealLight,
        textDecoration: "none",
        borderBottom: `1px solid ${C.tealLight}44`,
        transition: `border-color 0.15s ${EASE}`,
      }}
    >
      {children}
    </Link>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: FM,
        fontSize: "0.88em",
        color: C.textPrimary,
        background: C.surface,
        padding: "1px 6px",
        borderRadius: 4,
        border: `0.5px solid ${C.border}`,
      }}
    >
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        fontFamily: FM,
        fontSize: 12.5,
        lineHeight: 1.65,
        background: C.surface,
        border: `0.5px solid ${C.border}`,
        borderRadius: 8,
        padding: "14px 16px",
        overflowX: "auto",
        margin: 0,
        marginBottom: 14,
        color: C.textSecondary,
      }}
    >
      <code>{children}</code>
    </pre>
  );
}

function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul
      style={{
        margin: 0,
        marginBottom: 14,
        paddingLeft: 20,
        color: C.textSecondary,
        lineHeight: 1.75,
        fontSize: 14.5,
      }}
    >
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 6 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function OL({ items }: { items: React.ReactNode[] }) {
  return (
    <ol
      style={{
        margin: 0,
        marginBottom: 14,
        paddingLeft: 22,
        color: C.textSecondary,
        lineHeight: 1.75,
        fontSize: 14.5,
      }}
    >
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 8 }}>
          {item}
        </li>
      ))}
    </ol>
  );
}

function Table({
  cols,
  rows,
}: {
  cols: string[];
  rows: string[][];
}) {
  return (
    <div
      style={{
        border: `0.5px solid ${C.border}`,
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: cols.map(() => "minmax(0, 1fr)").join(" "),
          gap: 12,
          padding: "10px 14px",
          background: C.bg,
          borderBottom: `0.5px solid ${C.border}`,
          fontFamily: FM,
          fontSize: 10,
          letterSpacing: "0.14em",
          color: C.textMuted,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        {cols.map((c) => (
          <div key={c}>{c}</div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: cols.map(() => "minmax(0, 1fr)").join(" "),
            gap: 12,
            padding: "12px 14px",
            borderBottom:
              i === rows.length - 1 ? "none" : `0.5px solid ${C.border}`,
            fontSize: 13.5,
            color: C.textSecondary,
            lineHeight: 1.5,
            alignItems: "start",
          }}
        >
          {row.map((cell, j) => (
            <div
              key={j}
              style={{
                color: j === 0 ? C.textPrimary : C.textSecondary,
                fontFamily: j === 0 ? FD : FS,
                fontWeight: j === 0 ? 500 : 300,
              }}
              dangerouslySetInnerHTML={{ __html: cell.replace(/&apos;/g, "&#39;") }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Endpoint({
  method,
  path,
  description,
  params,
  responseNote,
}: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  params: Array<[string, string, string]>;
  responseNote?: string;
}) {
  const methodColor =
    method === "GET"
      ? C.tealLight
      : method === "POST"
        ? "#fbbf24"
        : method === "DELETE"
          ? C.red
          : C.textSecondary;
  return (
    <div
      style={{
        border: `0.5px solid ${C.border}`,
        borderRadius: 8,
        marginBottom: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: C.bg,
          borderBottom: `0.5px solid ${C.border}`,
        }}
      >
        <span
          style={{
            fontFamily: FM,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.1em",
            color: methodColor,
            padding: "2px 8px",
            borderRadius: 4,
            border: `0.5px solid ${methodColor}44`,
            background: `${methodColor}14`,
          }}
        >
          {method}
        </span>
        <span
          style={{
            fontFamily: FM,
            fontSize: 13,
            color: C.textPrimary,
          }}
        >
          {path}
        </span>
      </div>
      <div
        style={{
          padding: "12px 14px",
          color: C.textSecondary,
          fontSize: 13.5,
          lineHeight: 1.6,
        }}
      >
        <div style={{ marginBottom: params.length > 0 ? 12 : 0 }}>
          {description}
        </div>
        {params.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 140px) minmax(0, 80px) minmax(0, 1fr)",
              columnGap: 12,
              rowGap: 6,
              fontFamily: FM,
              fontSize: 12,
            }}
          >
            {params.map(([name, type, desc]) => (
              <React.Fragment key={name}>
                <div style={{ color: C.textPrimary }}>{name}</div>
                <div style={{ color: C.tealLight }}>{type}</div>
                <div style={{ color: C.textSecondary, fontFamily: FS, lineHeight: 1.5 }}>
                  {desc}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
        {responseNote && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: `0.5px solid ${C.border}`,
              fontFamily: FM,
              fontSize: 12.5,
              color: C.textMuted,
              lineHeight: 1.55,
            }}
          >
            {responseNote}
          </div>
        )}
      </div>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div
      style={{
        marginBottom: 16,
        paddingBottom: 16,
        borderBottom: `0.5px solid ${C.border}`,
      }}
    >
      <div
        style={{
          fontFamily: FD,
          fontSize: 14,
          fontWeight: 600,
          color: C.textPrimary,
          marginBottom: 6,
          letterSpacing: "-0.005em",
        }}
      >
        {q}
      </div>
      <div
        style={{
          fontFamily: FS,
          fontSize: 13.5,
          color: C.textSecondary,
          lineHeight: 1.7,
        }}
      >
        {a}
      </div>
    </div>
  );
}
