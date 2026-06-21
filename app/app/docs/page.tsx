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
      { id: "dbp-pricing",     label: "Live pricing",      render: () => <DbpPricing /> },
      { id: "dbp-oracle",      label: "Oracle & expiries", render: () => <DbpOracle /> },
      { id: "dbp-strip",       label: "The strip",         render: () => <DbpStrip /> },
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
        USDC — is a testnet token with no monetary value. Post Sui Overflow, we hope to push Pelagos to mainnet and continue
        developing it with support from the Sui ecosystem.
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
        Pelagos is a <B>structured-products desk for prediction markets</B>,
        built on Sui. It takes the simple yes/no contracts that a prediction
        protocol exposes and packages them into the kind of instruments a
        trading desk actually uses — options chains, volatility structures,
        diversified baskets, principal-protected notes, and seniority slices —
        each priced and settled on-chain through{" "}
        <B>DeepBook Predict</B>, Mysten&apos;s on-chain prediction protocol.
      </P>
      <P>
        The point is to let you express a <B>nuanced market view</B> in a
        single, well-defined position. Instead of placing one bet on one
        outcome, you can take a view on <B>where</B> an asset lands, on{" "}
        <B>how much it moves</B>, or on a whole <B>portfolio</B> of unrelated
        events — and have Pelagos assemble and settle the underlying contracts
        for you, in one wallet signature where possible.
      </P>
      <P>
        Everything on the pricing and settlement path is real. Each leg is a
        live DeepBook Predict contract with a $1 binary payout, quoted off the
        protocol&apos;s own order book and settled natively on chain. Pelagos
        reads live prices and builds the transaction; it does not invent marks
        or quote a synthetic price that the protocol would not honour.
      </P>
      <SubHeading>The product suite</SubHeading>
      <P>
        Five product families share one settlement engine. Each is documented
        in full under <B>Products</B> — what it is, when you would use it, how
        the payoff works, and how to trade it step by step:
      </P>
      <UL
        items={[
          <>
            <B>Distributed Options</B> — a live BTC options chain. Calls and
            puts at every strike and expiry, each a $1 binary settled on Sui.
          </>,
          <>
            <B>Volatility</B> — prebuilt volatility structures (straddle,
            strangle, butterfly, iron condor) with a live payoff diagram,
            greeks, and an optional delta-hedge leg.
          </>,
          <>
            <B>Distribution Markets</B> — take a view on the full distribution
            of where an asset settles, not just one strike.
          </>,
          <>
            <B>Tranches (Risk Slices)</B> — senior, mezzanine, and junior
            seniority slices of the same view, from high-probability/low-payout
            to convex/high-payout.
          </>,
          <>
            <B>Protected Notes</B> — a position sized to a principal floor and
            paired with an upside sleeve.
          </>,
        ]}
      />
      <P>
        A sixth surface, <B>Event Baskets</B>, bundles unrelated
        prediction-market events into a single diversified position.
      </P>
      <SubHeading>Two interfaces</SubHeading>
      <P>
        A global <B>Basic / Advanced</B> toggle in the header reskins every
        product. Basic is clean, guided, and prebuilt — pick a structure and
        open it. Advanced is the institutional desk: order books, an
        interactive 3D volatility surface, the tranching engine, full greeks,
        and on-chain deployment detail. The toggle, the light/dark theme, and{" "}
        <Code>?mode=</Code> / <Code>?theme=</Code> deep links all persist per
        browser, so a link opens the exact view you shared.
      </P>
      <SubHeading>Non-custodial by construction</SubHeading>
      <P>
        Pelagos never holds your funds. Its backend is a pricing and
        orchestration layer that builds <B>unsigned</B> transactions; your
        wallet signs and executes every one, and your wallet owns the on-chain
        account that gates every mint and redeem. Positions mint and settle
        on-chain on Sui, in your name. The <B>Non-custodial flow</B> page below
        walks the full prepare → sign → confirm path.
      </P>
    </>
  );
}

function ProductSuite() {
  return (
    <>
      <P>
        Pelagos ships a full structured-product suite over one shared,
        live-priced settlement engine. The primary navigation is{" "}
        <B>Portfolio · Distributed Options · Volatility · DeepBook · Baskets ·
        About</B>. The table below is a quick map of what each product is and
        when you would reach for it; each has its own page under{" "}
        <B>Products</B> with the full how-to.
      </P>
      <Table
        cols={["Product", "What it is", "When you'd use it"]}
        rows={[
          [
            "Distributed Options",
            "Live BTC options chain — calls and puts across every on-chain expiry (≈15m → 22d), each a $1 binary settled on Sui.",
            "You have a directional view on BTC by a specific time and want a clean, capped option position.",
          ],
          [
            "Volatility",
            "Prebuilt vol structures (straddle, strangle, butterfly, iron condor) with a live payoff diagram, greeks, and an optional delta-hedge leg. Advanced adds a 3D vol surface.",
            "You have a view on how much an asset moves, regardless of direction — high vol, low vol, or pinned to a level.",
          ],
          [
            "Distribution Markets",
            "Take a view on the full distribution of where an asset settles — a centre and a width — rather than a single strike.",
            "You think the market is mispricing the shape or location of the outcome distribution, not just up vs down.",
          ],
          [
            "Tranches (Risk Slices)",
            "Senior, mezzanine, and junior seniority slices of the same view — from high-probability/low-payout to convex/high-payout.",
            "You want to dial the same thesis to your risk appetite: steady and likely, or aggressive and convex.",
          ],
          [
            "Protected Notes",
            "A position sized to a principal floor, paired with an upside sleeve.",
            "You want defined downside with participation in the upside of a view.",
          ],
          [
            "Event Baskets",
            "A diversified bundle of unrelated prediction-market events in a single position, plus curated one-click DeepBook recipes.",
            "You want broad exposure to many events at once without hand-picking and sizing each one.",
          ],
        ]}
      />
      <SubHeading>Shared surfaces</SubHeading>
      <P>
        Every product reads from the same backend and writes through the same
        non-custodial prepare / sign / confirm flow. The{" "}
        <DocLink href="/app/portfolio">Portfolio</DocLink> view aggregates your
        holdings across all products with live mark-to-market and running
        P&amp;L, marking each open position to the price the protocol would pay
        to redeem it right now.
      </P>
      <SubHeading>Where each lives</SubHeading>
      <UL
        items={[
          <>
            <DocLink href="/app/distribution">Distributed Options</DocLink>{" "}
            — the BTC options chain and the distribution view.
          </>,
          <>
            <DocLink href="/app/volatility">Volatility</DocLink> — vol
            structures, the 3D surface, and the multi-leg builder.
          </>,
          <>
            <DocLink href="/app/deepbook">DeepBook</DocLink> — prebuilt range
            strategies and Protected Notes.
          </>,
          <>
            <DocLink href="/app/basket">Baskets</DocLink> — curated DeepBook
            recipes and diversified event baskets, with the tranching engine in
            Advanced.
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
      ├── DeepBook Predict   live pricing · vol surface · settlement
      ├── Event markets      basket legs + order-book pricing
      ├── DeFiLlama          live Sui USDC lending APY (note floors)
      └── Sui RPC            pelagos_sui / _vault / _strategies moveCalls
      │
      └── Monitor :13102     process / API / on-chain / market metrics`}
      </CodeBlock>
      <SubHeading>Backend engines</SubHeading>
      <UL
        items={[
          <>
            <B>predict/</B> — live pricing, the volatility surface, and the
            transaction builders. The shared core under Distributed Options,
            Volatility, Distribution, Tranches, and Notes.
          </>,
          <>
            <B>options-chain</B> — the BTC options chain: each strike priced
            off live Predict liquidity, with implied volatility from the live
            surface and a depth and risk cap per strike.
          </>,
          <>
            <B>volatility</B> — prebuilt vol structures and greeks.
          </>,
          <>
            <B>baskets</B> — event-market discovery, basket construction, and
            tranching. The selection and diversification logic is Pelagos&apos;s
            own and runs entirely server-side.
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
            <B>Prepare.</B> The frontend posts your chosen parameters (the
            product, budget, and any product-specific settings) to a{" "}
            <Code>/prepare</Code> route. The backend prices the legs against
            live Predict liquidity and returns unsigned <Code>tx_bytes</Code>{" "}
            plus a dry-run result.
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
        DeepBook Predict is Mysten&apos;s on-chain prediction protocol. It
        prices contracts against a live BTC volatility-surface oracle and
        exposes two simple primitives. Every Pelagos product is assembled from
        these two building blocks, so it is worth understanding them.
      </P>
      <UL
        items={[
          <>
            <B>Binary.</B> Pays $1 per contract if settlement finishes above
            (UP) or at/below (DOWN) a single strike. This is a clean
            directional bet on one level — the building block behind a single
            call or put.
          </>,
          <>
            <B>Range.</B> Pays $1 per contract if settlement lands inside a
            chosen price band — between a lower and an upper bound. This is a
            bet that the asset finishes <B>within</B> a region, the building
            block behind volatility structures and distribution views.
          </>,
        ]}
      />
      <SubHeading>From one strike to a view</SubHeading>
      <P>
        A single binary or range is a bet on one level or one band. Pelagos
        combines several of them into a single position that expresses a richer
        view — a direction, a width, or a whole shape of where an asset might
        land. You set the view; Pelagos selects and sizes the underlying
        contracts and mints them together. How those contracts are chosen and
        weighted is Pelagos&apos;s own logic; what you get back is one position
        whose payoff matches your view.
      </P>
      <SubHeading>Whole-contract settlement</SubHeading>
      <P>
        Contracts are whole and each pays exactly $1 at settlement if it
        finishes in the money. That makes the maximum payout, the cost, and the
        downside of any Pelagos position easy to read off the quote before you
        sign — there are no hidden legs or off-book marks.
      </P>
    </>
  );
}

function DbpPricing() {
  return (
    <>
      <P>
        This is the heart of the integration, and the most important honesty
        guarantee in Pelagos: <B>no price on the path is invented</B>. Every
        leg is quoted off the protocol&apos;s own live order book, at the
        actual size you are trading, before you sign. The quote you see is the
        price the protocol will charge.
      </P>
      <P>
        Pricing reads run as simulations against on-chain state — no funds and
        no signature are required to get a live quote. That is why you can
        explore prices freely without connecting a wallet or spending anything.
      </P>
      <SubHeading>Priced at your real size</SubHeading>
      <P>
        Crucially, a Pelagos quote is priced at the <B>real quantity</B> you
        are about to trade, not at an idealised one-contract reference. Because
        the protocol prices against the state your order would leave behind,
        the cost it returns already includes the market-maker spread and the
        slippage your own order adds. There is no synthetic AMM and no
        better-looking mark hiding the true cost of size.
      </P>
      <SubHeading>What the quote tells you</SubHeading>
      <P>
        For every position, Pelagos surfaces both sides of the market and the
        derived figures you need to decide:
      </P>
      <UL
        items={[
          <><B>Cost to open</B> — the ask you pay to mint at your size, spread and slippage included.</>,
          <><B>Redeem-now value</B> — the bid you would receive closing the position immediately.</>,
          <><B>Maximum payout</B> — the most the position can pay if your view is right.</>,
          <><B>Spread</B> — the round-trip cost of opening and immediately closing at this size.</>,
          <><B>Expected value</B> — the position&apos;s value under your own stated view.</>,
        ]}
      />
      <SubHeading>Tradeable means tradeable</SubHeading>
      <P>
        The protocol only mints contracts inside a sensible probability band;
        a contract that has become too extreme cannot be minted. Pelagos checks
        this up front and only surfaces a leg as tradeable when it will
        actually mint at your size, with a deliberate safety margin so
        post-trade slippage cannot push it out of bounds. Legs that fall
        outside the band are shown as untradeable rather than quoted at a
        fictional price — Pelagos never surfaces a number it cannot honour
        on-chain.
      </P>
    </>
  );
}

function DbpOracle() {
  return (
    <>
      <P>
        DeepBook Predict prices against a live BTC{" "}
        <B>volatility-surface oracle</B>. Pelagos reads that surface and the
        forward price directly from the protocol, so every strike,
        probability, and greek you see is grounded in the same source the
        protocol settles against — not a separate model Pelagos maintains on
        the side.
      </P>
      <SubHeading>The volatility surface</SubHeading>
      <P>
        The backend exposes the live surface at{" "}
        <Code>GET /api/predict/vol-surface</Code> and an implied density at{" "}
        <Code>GET /api/predict/density</Code>. The Advanced{" "}
        <DocLink href="/app/volatility">Volatility</DocLink> desk renders this
        as an interactive 3D surface with smile and term-structure analytics,
        and greeks are computed off the live surface rather than a flat-vol
        assumption — so delta, gamma, vega, and theta reflect the market the
        protocol actually settles against.
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
        Most Pelagos products are not a single contract — they are a small
        <B> set of range contracts assembled into one position</B>. Pelagos
        calls this a <B>strip</B>. The strip is what lets a position track a
        view that no single binary or range could express on its own: a
        direction, a width, or a whole shape of where an asset might land.
      </P>
      <SubHeading>What a strip is, in plain terms</SubHeading>
      <P>
        You describe the view you want — for example, &ldquo;BTC finishes near
        this level&rdquo; or &ldquo;BTC moves a lot in either direction.&rdquo;
        Pelagos selects a handful of adjacent price bands that, together, pay
        out in proportion to that view, sizes each one, prices the whole set
        live at your real order size, and presents it as a single quote with
        one cost and one maximum payout. The choice and weighting of those
        bands is Pelagos&apos;s own logic; what you interact with is one clean
        position.
      </P>
      <SubHeading>How each product shapes the strip</SubHeading>
      <Table
        cols={["Product", "How it uses the strip"]}
        rows={[
          ["Distribution Markets", "You set the centre and width of the view directly."],
          ["Tranches (Risk Slices)", "The same view taken at three preset widths — senior (narrow), mezzanine (mid), junior (wide)."],
          ["Protected Notes", "An upside strip paired with a principal floor; see Protected Notes."],
          ["Event Baskets", "Curated one-click recipes — a tight pin, a moderate spread, or a wide range."],
          ["Volatility", "Several strips composed into a straddle, strangle, butterfly, or iron condor."],
        ]}
      />
      <SubHeading>One signature</SubHeading>
      <P>
        A whole strip mints in a single programmable transaction block: an
        optional one-time account bootstrap, the deposit, and all of the range
        legs — bundled and signed once. You approve one transaction and the
        entire position is created on-chain.
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
        <B>What it is.</B> Distributed Options is a live BTC options chain.
        Every strike is a real on-chain contract with a $1 binary payout,
        priced live off DeepBook Predict&apos;s own order book. Contracts are
        whole, depth- and risk-capped per strike, and settled on Sui.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When you have a directional view on BTC by a specific time — &ldquo;BTC
        is above $X by Friday&rdquo; — and you want a clean, capped position to
        express it. A call pays if BTC finishes above your strike; a put pays
        if it finishes below. Your downside is limited to what you pay, and the
        most you can make is fixed and shown up front.
      </P>
      <SubHeading>How the payoff works</SubHeading>
      <P>
        Each contract is a $1 binary. If it finishes in the money it pays $1
        per contract; if not, it pays nothing. You pay the live ask to open. So
        the position&apos;s maximum payout is one dollar times your contract
        count, and the price you pay reflects the market&apos;s current
        probability of finishing in the money. There are no margin calls and no
        liquidation — the most you can lose is the premium you paid.
      </P>
      <SubHeading>The chain</SubHeading>
      <P>
        Calls and puts are laid out across every on-chain expiry, from roughly
        fifteen minutes to about twenty-two days. Each strike shows the live
        ask and bid, the implied volatility from the live surface, and a
        per-strike depth cap so an order can never exceed what is actually
        mintable. The chain is served by{" "}
        <Code>GET /api/options/chain</Code> with per-strike depth at{" "}
        <Code>GET /api/options/depth</Code>.
      </P>
      <SubHeading>How to trade it</SubHeading>
      <OL
        items={[
          <>Open <DocLink href="/app/distribution">Distributed Options</DocLink> and pick an expiry and strike.</>,
          <>Choose call or put and a contract count. The quote shows the ask, the implied volatility, and the depth-capped maximum you can buy.</>,
          <>Pick your settlement rail — dUSDC or Pelagos USDC — and confirm. Your wallet signs a single transaction that mints the position.</>,
          <>Hold to settlement for the binary payout, or close early at the live bid. The position shows in your <DocLink href="/app/portfolio">Portfolio</DocLink> with a live mark.</>,
        ]}
      />
      <SubHeading>Why it is honest</SubHeading>
      <P>
        Because each strike is a real on-chain contract, the price the chain
        shows is the price the protocol charges — including the spread and the
        slippage your order itself adds. There is no synthetic AMM and no
        invented mark.
      </P>
    </>
  );
}

function PVolatility() {
  return (
    <>
      <P>
        <B>What it is.</B> The Volatility desk lets you trade <B>how much</B> an
        asset moves rather than which way. It ships prebuilt structures —
        straddle, strangle, butterfly, and iron condor — each a multi-leg
        position with a live payoff diagram, full greeks, and an optional
        delta-hedge leg.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When your view is about movement, not direction. A <B>straddle</B> or{" "}
        <B>strangle</B> pays when the asset moves sharply either way — buy it if
        you expect a big swing. A <B>butterfly</B> or <B>iron condor</B> pays
        when the asset stays near a level — buy it if you expect things to be
        quiet. In short: long-vol structures profit from turbulence, short-vol
        structures profit from calm.
      </P>
      <SubHeading>How the payoff works</SubHeading>
      <P>
        Each structure combines several contracts so that its payoff diagram
        has the classic shape you would expect — a V for a straddle, a tent for
        a butterfly. The desk draws that diagram live before you trade, so you
        can see exactly where the position makes and loses money, and the most
        it can pay or cost, against the current market.
      </P>
      <SubHeading>Basic and Advanced</SubHeading>
      <P>
        Basic presents the prebuilt structures with a payoff diagram and a
        one-click open. Advanced adds an interactive <B>3D volatility
        surface</B>, smile and term-structure analytics, and a multi-leg trade
        builder for composing custom structures. Both read the same live
        surface and price the same way.
      </P>
      <SubHeading>Greeks and hedging</SubHeading>
      <P>
        Greeks are computed off the live volatility surface rather than a
        flat-vol assumption, so delta, gamma, vega, and theta reflect the
        actual market the protocol settles against. The optional hedge leg
        sizes a delta-neutralising trade so you can isolate the volatility view
        from the direction, surfaced at <Code>GET /api/vol/hedge</Code>.
      </P>
      <SubHeading>How to trade it</SubHeading>
      <OL
        items={[
          <>Open <DocLink href="/app/volatility">Volatility</DocLink> and pick a structure (or build one in Advanced).</>,
          <>Set your budget and review the live payoff diagram and greeks.</>,
          <>Pick a settlement rail and confirm. Your wallet signs one multi-leg open.</>,
          <>Track and close the position from your <DocLink href="/app/portfolio">Portfolio</DocLink>.</>,
        ]}
      />
      <SubHeading>Routes</SubHeading>
      <UL
        items={[
          <><Code>GET /api/vol/surface</Code> — the live volatility surface for the desk.</>,
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
        <B>What it is.</B> Distribution Markets let you take a view on the{" "}
        <B>full shape of where an asset settles</B>, not just whether it
        finishes above or below one strike. You describe a centre (where you
        think it lands) and a width (how confident you are), and Pelagos builds
        a single position whose payoff tracks that view.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When your edge is about the distribution itself — &ldquo;BTC settles
        tightly around this level&rdquo; or &ldquo;the market is too confident;
        the real range is wider&rdquo; — rather than a one-sided up/down call.
        It is the most expressive way to state a probabilistic view on this
        desk, and the raw form that the other products specialise.
      </P>
      <SubHeading>How the payoff works</SubHeading>
      <P>
        The position pays the most when the asset settles where you said it
        would, and less the further it lands from your view. Concentrate the
        view (a narrow width) for a high-conviction, high-payout-if-right bet;
        spread it out (a wide width) for a steadier, more forgiving payoff. The
        quote shows the total cost, the maximum payout, and the value of the
        position under your own stated view before you commit.
      </P>
      <SubHeading>How to trade it</SubHeading>
      <OL
        items={[
          <>
            On <DocLink href="/app/distribution">Distribution</DocLink>, set
            the centre and width of your view, plus a budget.
          </>,
          <>
            The live preview prices the whole position against the protocol,
            showing per-band ask and bid and the totals for the position.
          </>,
          <>
            Pick a settlement rail and confirm. Your wallet signs one
            transaction that mints the full position.
          </>,
          <>
            Close early at the live bid, or hold to settlement and claim the
            payout once the oracle resolves.
          </>,
        ]}
      />
      <SubHeading>What the quote tells you</SubHeading>
      <P>
        Because the position is priced at your real order size against live
        on-chain state, the quote surfaces the true cost of expressing the
        view: total cost, maximum payout, the round-trip spread, and the
        position&apos;s expected value under your view. Any leg that the
        protocol cannot currently mint is shown as untradeable rather than
        quoted at a fictional price.
      </P>
    </>
  );
}

function PSlices() {
  return (
    <>
      <P>
        <B>What it is.</B> Tranches — shown in the app as <B>Risk Slices</B> —
        let you take the same market view at three different risk appetites.
        Senior, mezzanine, and junior slices run from a steady,
        high-probability position to an aggressive, convex one.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When you and the market agree on the thesis but you want to choose how
        much risk to take expressing it. Pick <B>senior</B> for a likely,
        modest payout; <B>junior</B> for a less likely but much larger one;{" "}
        <B>mezzanine</B> for the balance in between.
      </P>
      <Table
        cols={["Slice", "Profile", "Resembles"]}
        rows={[
          ["Senior", "Narrow, around the expected level. High probability of paying, modest payout.", "An investment-grade claim."],
          ["Mezzanine", "Mid-width. Balanced probability and payout.", "A call spread."],
          ["Junior", "Wide. Lower probability, convex, high payout if it hits.", "A deep out-of-the-money option."],
        ]}
      />
      <SubHeading>How the payoff works</SubHeading>
      <P>
        All three slices are built from the same underlying view; they differ
        in how much of the outcome range they cover. The senior slice sits
        tightly around the expected level, so it pays often but modestly. The
        junior slice reaches for the tails, so it pays rarely but large. The
        Advanced <DocLink href="/app/basket">Baskets</DocLink> surface renders
        the three side by side with live quotes so the trade-off between
        probability and payout is legible at a glance.
      </P>
      <SubHeading>How seniority is enforced</SubHeading>
      <P>
        Seniority on Pelagos is a <B>structured position that Pelagos tracks
        and enforces in its own accounting layer</B>, over pooled vault
        deposits — not an on-chain waterfall. Each slice is a defined position
        with its own pricing and payout, and Pelagos is responsible for
        bookkeeping the slice ordering and settling each one accordingly. There
        is no separate on-chain seniority or waterfall contract, and Pelagos
        does not claim one.
      </P>
      <P>
        Each slice is quoted through{" "}
        <Code>POST /api/predict/tranche/quote</Code>, priced live against the
        protocol just like any other position.
      </P>
    </>
  );
}

function PNotes() {
  return (
    <>
      <P>
        <B>What it is.</B> A Principal-Protected Note (PPN) pairs a{" "}
        <B>principal floor</B> with an <B>upside sleeve</B>. You commit a
        budget; most of it is held against a target floor so the bulk of your
        principal is preserved, and the remainder buys an upside position that
        participates if your view plays out.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When you want defined downside with some participation in the upside —
        the structured-note classic. You give up some of the upside you would
        get from an outright position in exchange for protecting most of your
        principal if the view does not work out.
      </P>
      <SubHeading>How the split works</SubHeading>
      <UL
        items={[
          <>
            <B>Floor portion.</B> The larger share of your deposit is allocated
            to the protected portion of the note, sized to your chosen floor
            target.
          </>,
          <>
            <B>Upside sleeve.</B> The remainder buys an upside position
            expressing your view, carrying the participation.
          </>,
          <>
            <B>One signature.</B> The split and both legs are bundled by{" "}
            <Code>POST /api/predict/ppn/open/prepare</Code> and signed once.
          </>,
        ]}
      />
      <SubHeading>How the floor is enforced</SubHeading>
      <P>
        Important and honest: the principal floor is a{" "}
        <B>structured position that Pelagos tracks and enforces in its own
        accounting layer</B>, over pooled vault deposits — it is{" "}
        <B>not</B> an on-chain-enforced principal guarantee. Pelagos is
        responsible for the bookkeeping that sizes and honours the floor; the
        underlying funds sit in a pooled vault. The floor target is informed by
        real Sui USDC lending rates (via DeFiLlama) so it is grounded in live
        market yields rather than a fixed assumption. The prebuilt strategies
        and the note builder live on the{" "}
        <DocLink href="/app/deepbook">DeepBook</DocLink> surface.
      </P>
      <SubHeading>Honest floor</SubHeading>
      <P>
        Principal protection is a <B>target, not a guarantee</B>. It depends on
        vault solvency, redemption availability, and settlement timing, and on
        Pelagos&apos;s accounting — see the risk summary. Pelagos does not claim
        on-chain-enforced principal protection.
      </P>
    </>
  );
}

function PBaskets() {
  return (
    <>
      <P>
        <B>What it is.</B> Baskets come in two flavours: curated DeepBook range
        recipes for a quick one-click BTC view, and diversified
        prediction-market event baskets that bundle many unrelated events into
        a single position. They share the basket terminal but sit on different
        settlement rails.
      </P>
      <SubHeading>When you&apos;d use it</SubHeading>
      <P>
        When you want broad exposure without hand-picking and sizing every leg.
        Reach for a <B>DeepBook recipe</B> when you want a fast, prebuilt BTC
        position; reach for an <B>Event Basket</B> when you want spread-out
        exposure across many events at once, so no single outcome dominates the
        position.
      </P>
      <SubHeading>DeepBook baskets</SubHeading>
      <P>
        One-click prebuilt BTC positions — a tight pin, a moderate spread, and
        a wide range — each a ready-made distribution view. They are quoted
        through <Code>GET /api/predict/baskets</Code> and{" "}
        <Code>POST /api/predict/basket/quote</Code> and settle on DeepBook
        Predict.
      </P>
      <SubHeading>Event Baskets</SubHeading>
      <P>
        Diversified baskets of live prediction-market events. The point of a
        basket is <B>diversification</B>: Pelagos selects and weights the legs
        so the basket spreads risk across genuinely different outcomes rather
        than holding many variants of the same bet. <B>How</B> Pelagos selects
        and diversifies the legs is its own proprietary logic and runs entirely
        server-side. These baskets settle on Pelagos&apos;s own vault in Pelagos
        USDC, kept distinct from the Predict-backed suite so a demo is never
        bottlenecked on the dUSDC faucet.
      </P>
      <SubHeading>Tranches in Advanced</SubHeading>
      <P>
        The Basic <DocLink href="/app/basket">Baskets</DocLink> view is a clean
        basket terminal; Advanced is the{" "}
        <DocLink href="/app/basket">Risk Slices</DocLink> tranching engine,
        rendering senior, mezzanine, and junior on the same basket so you can
        choose your seniority. As with all tranches, seniority is tracked and
        enforced by Pelagos&apos;s accounting layer, not an on-chain waterfall.
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
        Every trade picks one of two settlement rails, and you choose per
        trade. <B>Both work end-to-end</B>, including redemption, and both are
        1:1 in USD. The only difference is the token and how you get it.
      </P>
      <Table
        cols={["Rail", "Token", "How you get it"]}
        rows={[
          [
            "dUSDC",
            "DeepBook Predict&apos;s own quote asset (the real one).",
            "From the testnet faucet — it is not freely mintable by Pelagos.",
          ],
          [
            "Pelagos USDC (mUSDC)",
            "Pelagos&apos;s demo USDC, for frictionless testing.",
            "Freely mintable on demand via a shared, permissionless faucet.",
          ],
        ]}
      />
      <SubHeading>The key thing to understand</SubHeading>
      <P>
        <B>mUSDC is just a demo token.</B> A trade settled in mUSDC uses the{" "}
        <B>same smart contracts, the same live DeepBook pricing, and the same
        backend flow</B> as a dUSDC trade — the only difference is that mUSDC is
        freely mintable, so you never wait on a faucet. dUSDC is the
        protocol&apos;s real quote asset (so it is the most faithful rail) but
        it is faucet-gated; mUSDC removes that bottleneck for testing and demos
        without changing how anything is priced or settled.
      </P>
      <SubHeading>Getting test funds</SubHeading>
      <P>
        The header <B>Test funds</B> button (shown when a wallet is connected)
        dispenses dUSDC, mUSDC, <B>and</B> SUI gas in a single transaction, so
        one click gets you everything you need to trade. Each Predict surface
        also shows a contextual top-up when your dUSDC balance is short.
      </P>
      <SubHeading>A note on DEEP</SubHeading>
      <P>
        DeepBook Predict settles purely in its dUSDC quote asset and does{" "}
        <B>not</B> use DEEP — that is DeepBook v3&apos;s CLOB fee token, and
        Pelagos places no v3 CLOB orders. Trading on Pelagos consumes only your
        chosen settlement token and SUI for gas; no DEEP is ever required.
      </P>
    </>
  );
}

function RailsLifecycle() {
  return (
    <>
      <P>
        Whatever the product, a Pelagos position follows the same lifecycle
        from quote to settlement. The event-basket path on the Pelagos USDC
        rail mirrors this same flow.
      </P>
      <OL
        items={[
          <>
            <B>Quote.</B> Your view (a direction, a structure, a slice, or a
            basket) is priced live off the protocol at your real order size.
            The quote shows the cost to open, the redeem-now value, the spread,
            and the position&apos;s expected value — no signature required to
            see it.
          </>,
          <>
            <B>Prepare.</B> The backend builds an unsigned transaction — on a
            first open, bundling the one-time account bootstrap, the deposit,
            and all of the legs — and dry-runs it for a gas estimate.
          </>,
          <>
            <B>Sign.</B> Your wallet signs the transaction. Your wallet owns the
            resulting on-chain account, and the position mints in your name.
          </>,
          <>
            <B>Confirm.</B> The executed digest is verified on chain and the
            position is recorded. It now shows in your{" "}
            <DocLink href="/app/portfolio">Portfolio</DocLink> with a live mark.
          </>,
          <>
            <B>Redeem or settle.</B> Close early at the live bid at any time, or
            hold to settlement and claim the payout once the oracle resolves.
            Redemption works on both settlement rails.
          </>,
        ]}
      />
      <SubHeading>Settlement and redemption</SubHeading>
      <P>
        Each leg is a $1 binary: at settlement, in-the-money legs pay $1 each
        and out-of-the-money legs pay nothing, so the total payout is the sum
        across the position&apos;s legs. Before settlement you can redeem at any
        time at the live bid — the protocol&apos;s current price to close — and
        once the oracle resolves, a winning position can be claimed
        permissionlessly. Pelagos does not adjudicate or override resolution; it
        reads and submits against the protocol.
      </P>
      <SubHeading>Mark-to-market</SubHeading>
      <P>
        While a position is open, its mark is the live redeem-now value of its
        legs — the same bid the protocol would pay, read off chain. The
        Portfolio surface aggregates this across all products into a single
        running P&amp;L.
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
            "Structured-note scaffolding plus admin settlement. Note floors and tranche seniority are tracked and enforced in Pelagos&apos;s accounting layer, not by an on-chain waterfall.",
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
        wallet-signed digests this deploy include a one-signature multi-leg
        mint and range mints and redeems in both directions, on both settlement
        rails. The indexer corroborates the mints and redeems. Every
        wallet-signed build dry-runs clean on chain, and a fresh mint→redeem
        cycle confirms the live path — including redemption — on current code.
        Full digests are in <Code>DEPLOYMENT.md</Code>.
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
        description="Live volatility surface for the Volatility desk and greeks."
        params={[]}
        responseNote="{ surface, smile, term_structure }"
      />
      <Endpoint
        method="GET"
        path="/api/predict/vault/summary"
        description="Live vault summary — NAV, share price, utilisation."
        params={[]}
        responseNote="{ nav, share_price, utilization }"
      />
      <SubHeading>Predict — pricing (the core preview)</SubHeading>
      <Endpoint
        method="POST"
        path="/api/predict/strip/preview"
        description="A view (centre + width) priced live at real size against the protocol. Surfaces cost to open, redeem-now value, spread, and expected value per leg and as totals."
        params={[
          ["asset", "string", "Default BTC; or oracle_id directly."],
          ["mu_usd", "number", "View centre (or mu_raw, 1e9)."],
          ["sigma_usd", "number", "View width (or sigma_raw, 1e9)."],
          ["budget_usd", "number", "Total spend (or budget_raw, 6dp)."],
          ["n", "number", "Number of legs."],
        ]}
        responseNote="{ legs: PricedLeg[], totals: StripQuote }"
      />
      <SubHeading>Predict — structured products (non-custodial)</SubHeading>
      <Endpoint
        method="POST"
        path="/api/predict/strip/open/prepare"
        description="Unsigned single-signature open for a distribution view. Bundles the one-time account bootstrap on a first open."
        params={[
          ["asset", "string", "Or oracle_id."],
          ["mu_usd", "number", "View centre."],
          ["sigma_usd", "number", "View width."],
          ["budget_usd", "number", "Total spend."],
          ["n", "number", "Number of legs."],
        ]}
        responseNote="{ tx_bytes, sender, dry_run }"
      />
      <Endpoint
        method="POST"
        path="/api/predict/ppn/open/prepare"
        description="Unsigned single-signature Protected Note open: floor portion plus an upside sleeve."
        params={[
          ["budget_usd", "number", "Total deposit."],
          ["floor_pct", "number", "Floor target as a fraction of the deposit."],
          ["mu_usd", "number", "Upside view centre."],
          ["sigma_usd", "number", "Upside view width."],
        ]}
        responseNote="{ tx_bytes, sender, dry_run }"
      />
      <Endpoint
        method="POST"
        path="/api/predict/tranche/quote"
        description="Senior / mezzanine / junior tranche quotes — the same view taken at three seniority widths."
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
        description="The BTC options chain — calls and puts across every live expiry, each priced off live Predict liquidity with implied volatility from the live surface and a per-strike depth cap."
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
        description="The prebuilt DeepBook baskets — a tight pin, a moderate spread, and a wide range."
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
  distribution/         // Distributed Options + distribution view
  volatility/           // Vol structures, vol surface, builder
  deepbook/             // Prebuilt range strategies + Protected Notes
  basket/               // DeepBook recipes + event baskets
  tranche/  ppn/        // Tranches + Notes (deep-link routes)
  portfolio/            // Holdings, mark-to-market, live P&L
  docs/                 // This About & docs surface
  _components/          // Header, shared layout
  _lib/                 // tokens, clients, mode/theme helpers`}
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
    predict/            // vol surface, pricing, PTB builders
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
        A structured position is a leveraged expression of a view on where an
        asset lands. If the asset settles away from your view the position pays
        little or nothing. A narrow, senior position pays often but modestly; a
        wide, junior position is convex and frequently expires worthless.
      </P>
      <P>
        <B>Scenario.</B> A junior tranche is opened for a sharp move. The asset
        settles near where it started — inside the senior band but outside the
        junior tails. The junior position pays zero even though a senior slice
        on the same view would have paid in full.
      </P>
      <SubHeading>Liquidity and slippage risk</SubHeading>
      <P>
        Because every leg is priced at your real order size, a large order pays
        the slippage it adds. Legs near the edges of the distribution can fall
        outside what the protocol will mint and become untradeable, and size
        that exceeds available depth is rejected rather than filled at a
        fictional price.
      </P>
      <SubHeading>Floor and seniority risk (Notes &amp; Tranches)</SubHeading>
      <P>
        Protected Note floors and tranche seniority are tracked and enforced in
        Pelagos&apos;s own accounting layer over pooled vault deposits — they
        are <B>not</B> on-chain-enforced guarantees or an on-chain waterfall.
        Principal protection is a target, not a guarantee: it depends on vault
        solvency, redemption availability, settlement timing, and the integrity
        of Pelagos&apos;s bookkeeping. A withdrawal delay around maturity, or a
        shortfall in the pooled deposits, can impair the floor or the ordering
        between slices.
      </P>
      <SubHeading>Oracle and settlement risk</SubHeading>
      <P>
        Settlement follows DeepBook Predict&apos;s oracle. Pelagos does not
        adjudicate or override resolution; an oracle fault or a delayed
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
        a="That is the goal. Post Sui Overflow, we hope to push Pelagos to mainnet and continue development with support from the Sui ecosystem; the repository stays available as a reference in the meantime."
      />
      <Faq
        q="What is DeepBook Predict and what does Pelagos add?"
        a="DeepBook Predict is Mysten's on-chain prediction protocol — it exposes simple binary and range contracts over a live BTC volatility-surface oracle. Pelagos calls it (does not deploy it) and adds a structured-product layer on top: options chains, volatility structures, distribution views, tranches, notes, and diversified baskets, each assembled from real on-chain contracts and minted in one signature where possible."
      />
      <Faq
        q="Where do the prices come from?"
        a="Every leg is quoted off the protocol's own live order book, at the real size you are trading, before you sign — and pricing reads need no funds and no signature. Nothing on the pricing path is invented or interpolated: the quote already includes the market-maker spread and the slippage your own order adds."
      />
      <Faq
        q="Is Pelagos custodial?"
        a="No. The backend builds unsigned programmable transaction blocks; the user's wallet signs and executes them, and the user's wallet owns the on-chain PredictManager that gates mint and redeem. The backend never holds user keys or collateral on the structured-product path."
      />
      <Faq
        q="Why are there two USDC tokens, and which should I pick?"
        a="You pick a settlement rail per trade. dUSDC is DeepBook Predict's real quote asset — the most faithful rail — but it is faucet-gated. Pelagos USDC (mUSDC) is a demo token that is freely mintable, so you never wait on a faucet. The crucial point: a trade in mUSDC uses the same smart contracts, the same live DeepBook pricing, and the same backend flow as a dUSDC trade, including redemption. For frictionless testing, use mUSDC; both are 1:1 in USD and both work end-to-end."
      />
      <Faq
        q="How do I get test funds?"
        a="The header 'Test funds' button (shown when a wallet is connected) dispenses dUSDC, mUSDC, and SUI gas in a single transaction — one click gets you everything you need to trade. Each Predict surface also shows a contextual top-up when your dUSDC balance is short."
      />
      <Faq
        q="Does Pelagos use DEEP?"
        a="No. DeepBook Predict is an AMM/PLP-backed range protocol that settles purely in dUSDC. DEEP is DeepBook v3's CLOB fee token; Pelagos places no v3 CLOB orders, and a live range mint consumes zero DEEP — only dUSDC and SUI gas."
      />
      <Faq
        q="What is a 'strip', and why does it matter?"
        a="Most Pelagos products are not a single contract but a small set of range contracts assembled into one position — Pelagos calls this a strip. It is what lets a position track a richer view than any single binary could: a direction, a width, or a whole shape of where an asset lands. You set the view; Pelagos selects and sizes the underlying contracts and presents one clean position with one cost and one maximum payout."
      />
      <Faq
        q="What are Tranches (Risk Slices)?"
        a="The same market view taken at three risk appetites: senior (narrow, high-probability, modest payout), mezzanine (balanced), and junior (wide, lower-probability, convex, high payout). Important and honest: tranche seniority is tracked and enforced in Pelagos's own accounting layer over pooled vault deposits — not an on-chain waterfall."
      />
      <Faq
        q="How is a Protected Note's floor produced and enforced?"
        a="Most of your deposit is held against a target principal floor and the remainder buys an upside sleeve; both settle in one signature. The floor is a structured position that Pelagos tracks and enforces in its own accounting layer over pooled vault deposits — it is NOT an on-chain-enforced principal guarantee. Principal protection is a target, not a guarantee: it depends on vault solvency, redemption availability, settlement timing, and Pelagos's bookkeeping."
      />
      <Faq
        q="Why are some strikes or legs shown as untradeable?"
        a="The protocol only mints contracts inside a sensible probability band; a contract that has become too extreme cannot be minted. Pelagos checks this up front and only surfaces a leg as tradeable when it will actually mint at your size, with a safety margin so post-trade slippage can't push it out of bounds. Legs that fall outside are shown as untradeable rather than quoted at a price Pelagos couldn't honour on-chain."
      />
      <Faq
        q="Which BTC expiries are available?"
        a="The protocol publishes a rolling ladder of BTC oracles, from roughly fifteen minutes out to about twenty-two days. Pelagos reads the active set live; expiring oracles drop off and new ones appear as the protocol rolls them."
      />
      <Faq
        q="Can I close a position before settlement?"
        a="Yes. A position can be redeemed at the live bid at any time while the market is open, on either settlement rail. Once the oracle settles, a winning position can be claimed permissionlessly. The Portfolio surface marks open positions to the live redeem-now value."
      />
      <Faq
        q="Do I need a wallet or funds just to see prices?"
        a="No. All pricing and previews run as read-only simulations against on-chain state, so you can explore live quotes for any product without connecting a wallet or spending anything. You only need a connected wallet and funds when you actually open or close a position."
      />
      <Faq
        q="What happens at settlement?"
        a="Each leg is a $1 binary: at settlement, in-the-money legs pay $1 each and out-of-the-money legs pay nothing, so the total payout is the sum across the position's legs. Pelagos does not adjudicate resolution — it reads and submits against the protocol's oracle."
      />
      <Faq
        q="Where can I verify it actually works on chain?"
        a="DEPLOYMENT.md lists the live testnet package and object IDs plus verified wallet-signed digests — a one-signature multi-leg mint and range mints and redeems in both directions — corroborated by the Predict indexer. Every build also dry-runs clean on chain before signing."
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
