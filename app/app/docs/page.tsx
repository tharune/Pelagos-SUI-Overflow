"use client";

/**
 * Docs page, styled after aave.com/docs:
 *   • Left sidebar with collapsible top-level sections, each holding a
 *     list of sub-pages. Active item highlighted. Click a sub-page to
 *     swap the main content.
 *   • Single centred content column with plain prose, minimal colour,
 *     one brand accent. Tables and code blocks are flat and quiet.
 *   • A short, human-voiced hackathon note at the very top of every
 *     view — one paragraph, no bullets, no corporate safety theatre.
 */

import React, { useMemo, useState } from "react";
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
    ],
  },
  {
    id: "market baskets",
    label: "Market Baskets",
    pages: [
      { id: "const-concept",   label: "Concept",           render: () => <ConstConcept /> },
      { id: "const-build",     label: "How baskets build", render: () => <ConstBuild /> },
      { id: "const-tiers",     label: "Risk tiers",        render: () => <ConstTiers /> },
      { id: "const-pricing",   label: "NAV and pricing",   render: () => <ConstPricing /> },
      { id: "const-trade",     label: "Buy and sell",      render: () => <ConstTrade /> },
    ],
  },
  {
    id: "tranches",
    label: "Risk Slices",
    pages: [
      { id: "tr-concept",      label: "Concept",           render: () => <TrConcept /> },
      { id: "tr-waterfall",    label: "Waterfall",         render: () => <TrWaterfall /> },
      { id: "tr-pricing",      label: "Pricing",           render: () => <TrPricing /> },
      { id: "tr-risk",         label: "Risk engine",       render: () => <TrRisk /> },
      { id: "tr-caps",         label: "Capacity caps",     render: () => <TrCaps /> },
    ],
  },
  {
    id: "ppn",
    label: "Principal-Protected Notes",
    pages: [
      { id: "ppn-concept",     label: "Concept",           render: () => <PpnConcept /> },
      { id: "ppn-split",       label: "Dynamic split",     render: () => <PpnSplit /> },
      { id: "ppn-payoff",      label: "Payoff",            render: () => <PpnPayoff /> },
      { id: "ppn-routing",     label: "Yield routing",     render: () => <PpnRouting /> },
    ],
  },
  {
    id: "distribution",
    label: "Distribution Markets",
    pages: [
      { id: "dist-concept",    label: "Concept",           render: () => <DistributionConcept /> },
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
          </article>
        </div>
      </PageFrame>
    </>
  );
}

// ---------------------------------------------------------------------------
// Hackathon note
// ---------------------------------------------------------------------------

/**
 * Disclaimer banner shown at the top of every documentation page.
 * Standard warning-box styling (amber left border, muted background,
 * bold label). Covers the hackathon scope: devnet/testnet only, no mainnet,
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
        Disclaimer
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
        Pelagos is a hackathon project built for the Sui ecosystem. The
        application is deployed to Sui testnet only. It is not
        a financial product, a securities offering, or investment advice,
        and no real capital is routed through any of its flows. There
        are no plans to deploy to mainnet, issue a token, or continue
        maintenance after the event. All displayed prices, payoffs, and
        yields are sandbox simulations.
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
        DOCUMENTATION
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
// Pages
// ---------------------------------------------------------------------------

function WhatIsPelagos() {
  return (
    <>
      <P>
        Pelagos is a structured-products protocol built on public
        prediction markets. Upstream venues expose a flat universe of
        single-question YES/NO markets; Pelagos composes that universe
        into four primitives: <B>Market Baskets</B>{" "}
        (weighted baskets of legs), <B>Risk Slices</B>{" "}
        (senior, mezzanine, and junior claims on a basket&apos;s terminal
        payout), <B>Principal-Protected Notes</B>{" "}
        (a basket position paired with a yield sleeve sized toward
        principal return at maturity), and <B>Distribution Markets</B>{" "}
        (bucketed probability curves for outcomes that are not
        naturally binary).
      </P>
      <P>
        The product surfaces share a single canonical basket grid:
        two risk tiers (High / Low) crossed with three
        resolution windows (Short / Med / Long). Each basket is
        addressable by a stable id and is referenced directly by
        tranche, PPN, and portfolio surfaces. The portfolio view
        aggregates positions across every product into a single
        list.
      </P>
      <SubHeading>Motivation</SubHeading>
      <P>
        A single prediction market pays out a binary outcome: the
        buyer receives face value if the event resolves YES and loses
        the premium otherwise. That shape is poorly suited to thematic
        exposure, diversified allocation, or defined risk/return
        trading. Pelagos addresses this gap by introducing three
        derived shapes on top of the underlying market:
      </P>
      <UL
        items={[
          <>
            <B>Diversified exposure.</B> A market basket holds 20–40
            weighted legs in a common theme, reducing idiosyncratic
            variance relative to a single-market position.
          </>,
          <>
            <B>Shaped payoff.</B> Risk Slices partition the basket&apos;s
            terminal NAV distribution into three non-overlapping
            claims with distinct attach and detach points.
          </>,
          <>
            <B>Downside target.</B> A PPN sizes a USDC yield sleeve
            so projected compounding can return the deposit at
            maturity; only the residual basket slice is exposed to
            market risk.
          </>,
        ]}
      />
      <SubHeading>Intended users</SubHeading>
      <P>
        Pelagos targets three user profiles: allocators seeking
        thematic exposure across many markets (Market Baskets),
        traders expressing a defined risk/return view on a basket
        (Risk Slices), and principal-sensitive depositors who require
        downside bounding (PPNs).
      </P>
    </>
  );
}

function ProductSuite() {
  return (
    <>
      <P>
        The core primitives share a common leg universe, basket grid,
        and portfolio surface. Positions in any product can be managed
        and unwound from a single portfolio view.
      </P>
      <Table
        cols={["Product", "Description", "Intended use"]}
        rows={[
          [
            "Market Baskets",
            "Weighted basket of prediction-market legs, quoted and settled at NAV.",
            "Thematic exposure to a group of related markets.",
          ],
          [
            "Risk Slices",
            "Senior, mezzanine, and junior claims on a basket&apos;s terminal payout.",
            "Defined risk/return positioning: downside protection, balanced yield, or convex tail upside.",
          ],
          [
            "PPN",
            "USDC yield sleeve sized toward principal return at maturity, paired with a basket slice that carries the upside.",
            "Floor-targeted exposure with a known maturity date.",
          ],
          [
            "Distribution Markets",
            "Live market groups transformed into outcome bands, scored by liquidity, orderbook depth, spread, time-to-resolution, and NLP quality.",
            "Expressing views over ranges, counts, or terminal values rather than a single binary outcome.",
          ],
        ]}
      />
      <SubHeading>Market Baskets</SubHeading>
      <P>
        Market Baskets are the base primitive. A market basket is a
        weighted basket of legs grouped by (tier, window). One token
        represents a pro-rata claim on the basket&apos;s weighted
        terminal NAV. Positions are opened and closed at NAV plus
        protocol and market-maker fees and book-walk slippage.
      </P>
      <SubHeading>Risk Slices</SubHeading>
      <P>
        Risk Slices partition the basket&apos;s terminal NAV distribution
        into three sequential claims. Senior absorbs the base layer
        and pays first; mezzanine covers the middle of the
        distribution; junior takes the residual tail. Each tranche is
        an independent token with its own quote, APY, and face-budget
        cap. Senior resembles an investment-grade bond, mezzanine a
        call spread, and junior a deep-out-of-the-money call.
      </P>
      <SubHeading>Principal-Protected Notes</SubHeading>
      <P>
        A PPN allocates a USDC deposit across a lending vault sleeve
        and a basket slice. The vault sleeve is sized so projected
        compounding returns the full deposit at maturity; the
        residual USDC purchases basket tokens at the prevailing NAV.
        Subject to vault solvency, the note&apos;s floor is the
        deposit; the ceiling is bounded by the basket at full YES
        resolution.
      </P>
      <SubHeading>Distribution Markets</SubHeading>
      <P>
        Distribution Markets let a user shape the whole outcome curve:
        each live band receives a probability weight, the backend
        normalizes the submitted curve, and compares the user&apos;s
        target curve against the market&apos;s current CLOB-implied
        reference curve. The position is target minus reference, and
        required collateral is the worst negative resolution band.
        This is the local implementation of
        the Paradigm distribution-market idea; a production version
        still needs native Move accounting and wallet-signed
        transactions.
      </P>
      <SubHeading>Cross-product navigation</SubHeading>
      <P>
        Each market basket detail page links to its tranche page;
        tranche pages link back to the underlying basket and to the
        PPN builder with the basket pre-selected. The PPN page exposes
        the vault aggregator. The portfolio view groups positions by
        basket id so market basket, tranche, and PPN exposure against
        the same basket render together.
      </P>
    </>
  );
}

function DistributionConcept() {
  return (
    <>
      <P>
        A Distribution Market trades a complete probability curve
        instead of one YES/NO token. The local implementation uses
        explicit buckets such as BTC terminal price bands, Sui TVL
        ranges, or a count of Fed cuts. The frontend sends every bucket
        weight to the backend, so the quote reflects the user&apos;s actual
        curve rather than a hardcoded preview.
      </P>
      <SubHeading>Local Sui flow</SubHeading>
      <UL
        items={[
          <>
            The frontend loads dynamic launch candidates from{" "}
            <Code>/api/distribution/candidates</Code>.
          </>,
          <>
            Band control changes call{" "}
            <Code>/api/distribution/quote</Code> to normalize the curve
            and compute the L2 quote, payout curve, collateral
            requirement, fees, and peak target band.
          </>,
          <>
            The backend builds each candidate from live Polymarket
            event groups, rejects poor distribution fits, and scores
            volume, CLOB depth, spread, time-to-resolution, and NLP
            quality.
          </>,
          <>
            Settlement calls{" "}
            <Code>/api/distribution/launch-plan</Code> returns the
            band market ids, token ids, initial weights, depth, and
            readiness status for a local launch.
          </>,
        ]}
      />
      <SubHeading>Production delta</SubHeading>
      <P>
        Production should replace backend-signed distribution actions
        with wallet-signed Sui programmable transaction blocks, native
        Move objects for curve accounting, indexed position state, and
        settlement rules tied to the chosen prediction-market source.
      </P>
    </>
  );
}

function Architecture() {
  return (
    <>
      <P>
        The system is composed of three surfaces: a Next.js frontend,
        an Express backend, and Sui Move packages deployed on Sui
        testnet. The frontend does not contact upstream
        prediction-market or yield-data APIs directly; all external
        traffic is proxied, cached, and normalised by the backend.
      </P>
      <SubHeading>Surfaces</SubHeading>
      <UL
        items={[
          <>
            <B>Frontend</B> — Next.js App Router under{" "}
            <Code>app/</Code>. Each product page consumes the
            six-basket roster, derives tranche, PPN, and payoff
            previews client-side, and dispatches local state
            transitions through a reducer whose action shapes mirror
            the on-chain program instructions.
          </>,
          <>
            <B>Backend</B> — Express service under{" "}
            <Code>backend/</Code>. Proxies the prediction-market API,
            aggregates USDC lending yields, exposes demo PPN routes,
            and quotes Distribution Market curves. Upstream calls are
            cached server-side with TTLs matched to data volatility
            (3 s for order books, 5 min for vault yields).
          </>,
          <>
            <B>On-chain</B> — Sui Move packages under{" "}
            <Code>pelagos_sui/</Code> deployed to Sui testnet.
            Local execution routes mint mock USDC, create prediction
            markets, buy position objects, resolve, and claim through
            the deployed package.
          </>,
        ]}
      />
      <SubHeading>Request flow</SubHeading>
      <P>A typical product page load executes the following steps:</P>
      <OL
        items={[
          <>
            The frontend requests the active market universe from the
            backend. The backend returns a cached snapshot and
            refreshes the cache asynchronously.
          </>,
          <>
            The frontend runs the basket-construction pipeline on the
            market list and materialises the six canonical baskets
            keyed by (tier, window).
          </>,
          <>
            Pages that require order-book depth (basket trade panel,
            tranche risk engine) batch token ids and call{" "}
            <Code>/api/markets/orderbooks</Code>.
          </>,
          <>
            The PPN yield-routing block calls{" "}
            <Code>/api/vaults/yields</Code>. The backend returns the
            top five USDC lending venues ranked by APY with a
            per-row freshness flag.
          </>,
          <>
            User actions (buy, sell, deposit, redeem) dispatch to the
            reducer, which emits the same action shapes the on-chain
            program would consume.
          </>,
        ]}
      />
      <SubHeading>Rationale for the proxy backend</SubHeading>
      <P>
        Routing external traffic through the backend centralises
        caching, rate-limit enforcement, and upstream schema
        normalisation. It also removes the need to distribute API
        credentials to the client and allows the data source to be
        changed without a frontend release.
      </P>
    </>
  );
}

function ConstConcept() {
  return (
    <>
      <P>
        A market basket is a weighted basket of prediction-market legs
        that share a (tier, window) signature. One market basket unit
        represents a pro-rata claim on the basket&apos;s weighted
        terminal NAV. At any given moment, NAV equals the
        weight-averaged YES probability across the basket&apos;s
        constituent legs. At resolution, each leg pays 1 if it resolves
        YES and 0 otherwise; the basket pays the weighted sum.
      </P>
      <SubHeading>Basket grid</SubHeading>
      <P>
        The basket universe is a fixed 2 × 3 grid of two risk tiers
        (High, Low) crossed with three resolution windows (Short:
        under 30 days; Med: 30–90 days; Long: over 90 days). The grid
        contains six canonical baskets and is regenerated on every
        refresh. Each basket is addressed by a stable id referenced by
        the tranche, PPN, and portfolio surfaces.
      </P>
      <SubHeading>Basket contents</SubHeading>
      <UL
        items={[
          <>
            <B>Legs.</B> Individual YES or NO sides of upstream
            markets. A low-probability market can contribute to a
            High-tier basket via its NO side.
          </>,
          <>
            <B>Weights.</B> One positive weight per leg, summing to 1.
            The largest single-leg weight is capped to limit
            concentration.
          </>,
          <>
            <B>Signature.</B> The (tier, window) pair plus a stable id
            derived from the leg set. Used for deep links and
            portfolio lookups.
          </>,
          <>
            <B>Resolution date.</B> The maximum end-date across the
            basket&apos;s legs. Displayed on every basket card and on
            the basket detail page.
          </>,
        ]}
      />
      <SubHeading>Example</SubHeading>
      <P>
        Consider a Low/Short basket containing 24 legs with
        probabilities between 1% and 12%, whose weighted YES
        probability is 0.05. A $1,000 deposit at NAV = $0.05 credits
        approximately 20,000 basket tokens net of fees. If the weighted
        terminal outcome is 0.06, the position redeems for 20,000 ×
        0.06 = $1,200 before fees, a gross return of 20%.
      </P>
    </>
  );
}

function ConstBuild() {
  return (
    <>
      <P>
        The basket construction pipeline in{" "}
        <Code>app/_lib/live-baskets.ts</Code> rebuilds all six baskets
        on every refresh in five sequential passes over the active
        market universe. The pipeline&apos;s structure is documented
        below; the specific weighting calibrations are not published.
      </P>
      <OL
        items={[
          <>
            <B>Ingest.</B> Retrieve the active market universe from the
            backend proxy. Each market contributes two candidate legs
            (YES and NO).
          </>,
          <>
            <B>Classify.</B> Tag each leg with a probability band and a
            resolution window derived from the market&apos;s end date.
            A keyword classifier assigns a category label used in
            downstream diversity checks.
          </>,
          <>
            <B>Deduplicate.</B> Collisions are resolved along three
            axes: shared market id, shared event id, and matching
            token-set hash on the question. Only one side of a given
            market can appear in the grid.
          </>,
          <>
            <B>Weight.</B> A sqrt-volume prior with a per-leg cap and
            floor is combined with a tilt that anchors each
            basket&apos;s weighted NAV to its tier target (approximately
            0.95 and 0.05). A seeded jitter introduces minor
            variation across refreshes.
          </>,
          <>
            <B>Emit.</B> All six (tier, window) cells are populated.
            If the preferred probability band does not yield at least
            ten legs, an extended band is applied so no cell remains
            empty.
          </>,
        ]}
      />
      <SubHeading>Refresh cadence</SubHeading>
      <P>
        The pipeline runs on product page mount and whenever the
        backend publishes a new market snapshot. Basket output is
        deterministic for a given snapshot, so concurrent clients
        observe identical ids and weights.
      </P>
      <SubHeading>Delisting</SubHeading>
      <P>
        If an upstream market is delisted, its leg is removed on the
        next refresh and the remaining weights are renormalised to
        sum to 1. No synthetic leg is substituted; the basket simply
        contains fewer legs until the next rebuild.
      </P>
    </>
  );
}

function ConstTiers() {
  return (
    <>
      <P>
        Tiers are structural labels applied during basket construction,
        not runtime filters. Each tier selects legs from a distinct
        slice of the upstream probability distribution, producing
        two baskets per window with materially different payoff
        profiles.
      </P>
      <Table
        cols={["Tier", "Probability band", "Target NAV", "Profile"]}
        rows={[
          ["High", "85–99%", "~95%", "Near-certain outcomes; limited upside and limited downside."],
          ["Low",  "1–12%",  "~5%",  "Long-tailed distribution; large proportional upside if legs resolve YES, near-total loss otherwise."],
        ]}
      />
      <SubHeading>Tier selection</SubHeading>
      <UL
        items={[
          <>
            <B>High.</B> Use for near-par exposure with tight NAV
            ranges. Appropriate as the basket slice of a low-variance
            PPN. Not suitable when convex upside is the objective.
          </>,
          <>
            <B>Low.</B> Use for convex upside. At a NAV near $0.05,
            each dollar purchases a large token count, so a modest
            number of YES resolutions produces an outsized return.
          </>,
        ]}
      />
      <SubHeading>Window selection</SubHeading>
      <P>
        The window tags the legs&apos; resolution horizon: Short (under
        30 days), Med (30–90 days), Long (over 90 days). Shorter
        windows resolve sooner and reduce mark-to-market variance;
        longer windows allow more time for underlying markets to
        re-price and therefore exhibit greater mid-life NAV drift from
        the tier target. Select the window that matches the intended
        holding period.
      </P>
    </>
  );
}

function ConstPricing() {
  return (
    <>
      <P>
        NAV is the weighted mean of the legs&apos; YES probabilities,
        computed from the live upstream snapshot. Buy and sell quotes
        apply symmetric protocol and market-maker fees and asymmetric
        slippage: buys walk the ask side, sells walk the bid. Sells
        also incur an adverse-selection premium that scales with order
        size and inverse depth.
      </P>
      <SubHeading>Quote anatomy</SubHeading>
      <CodeBlock>
        {`ask     = NAV + protocolFee + mmFee + buySlippage
bid     = NAV − protocolFee − mmFee − sellSlippage − adverseFee
mid     = NAV
spread  = ask − bid`}
      </CodeBlock>
      <UL
        items={[
          <>
            <B>Protocol fee.</B> Flat percentage on notional, accrued
            to the protocol.
          </>,
          <>
            <B>Market-maker fee.</B> Basis-point spread captured by
            the market maker on every round trip.
          </>,
          <>
            <B>Slippage.</B> Book walk on the underlying legs. For a
            buy of notional <Code>N</Code>, the pricing engine walks
            the ask side of each leg&apos;s order book and
            weight-averages the marginal prices across the basket
            weights.
          </>,
        ]}
      />
      <SubHeading>Adverse-selection premium</SubHeading>
      <P>
        Sell quotes include an additional premium proportional to{" "}
        <Code>sqrt(size / volumeProxy)</Code>, which rises with order
        size and falls with available market depth. This component
        compensates liquidity providers for the information content
        implicit in a large sell order. Premiums are negligible for
        small orders and become visible only on large orders against
        thin books.
      </P>
      <SubHeading>Slippage ceiling</SubHeading>
      <P>
        Orders whose total slippage exceeds 15% display a warning and
        are prevented from submission. If this ceiling is triggered,
        the order&apos;s notional exceeds the displayed depth of the
        basket&apos;s underlying legs; reduce size or split the order.
      </P>
    </>
  );
}

function ConstTrade() {
  return (
    <>
      <P>
        The basket detail page exposes a single trade panel with a
        Buy/Sell toggle. The quote preview updates as the notional or
        token quantity inputs change.
      </P>
      <SubHeading>Buy flow</SubHeading>
      <OL
        items={[
          <>Open the basket detail page from the Market Baskets grid.</>,
          <>
            Select <B>Buy</B> and enter a USDC notional.
          </>,
          <>
            Review the quote: NAV, ask, protocol and market-maker
            fees, slippage, and <Code>tokensOut</Code>.
          </>,
          <>
            Confirm. USDC is debited and{" "}
            <Code>tokensOut = netUsdc / ask</Code> basket tokens are
            credited to the portfolio under the basket id.
          </>,
        ]}
      />
      <SubHeading>Sell flow</SubHeading>
      <OL
        items={[
          <>
            Open the basket detail page. The sell panel is active
            regardless of whether a position is held, allowing quotes
            to be simulated.
          </>,
          <>
            Select <B>Sell</B> and enter a token quantity, or use the
            MAX shortcut to close the full position.
          </>,
          <>
            Review the quote: NAV, bid, protocol and market-maker
            fees, sell slippage, adverse-selection premium, and final
            USDC payout.
          </>,
          <>
            Confirm. Tokens are burned and{" "}
            <Code>payoutUsdc = qty × bid</Code> is credited to the
            wallet balance.
          </>,
        ]}
      />
      <SubHeading>Portfolio consistency</SubHeading>
      <P>
        The deposit action carries <Code>tokensOut</Code> from the buy
        panel into the reducer, ensuring the portfolio view matches
        the quoted token count exactly. Sells dispatch a{" "}
        <Code>basket/redeem</Code> action with quantity and payout
        guards to prevent partial fills from leaving residual
        positions.
      </P>
      <SubHeading>Hold-to-resolution</SubHeading>
      <P>
        Selling before resolution is optional. Positions held to
        resolution are closed through the portfolio view&apos;s{" "}
        <B>Resolve</B> action, which redeems each leg at its final
        binary payout and credits the weighted USDC amount.
        Resolution payouts do not incur adverse-selection or
        market-maker fees.
      </P>
    </>
  );
}

function TrConcept() {
  return (
    <>
      <P>
        A tranche is a defined claim on a subset of a
        market basket&apos;s terminal payout. Every basket in the grid
        has three tranches stacked on top of it: senior, mezzanine,
        and junior. Each tranche is an independent token with its own
        quote, face budget, and target APY. At resolution, the
        basket&apos;s weighted terminal NAV is distributed through a
        waterfall: senior claims its layer in full before mezzanine
        receives any payout, and mezzanine is satisfied in full before
        junior.
      </P>
      <SubHeading>Tranche kinds</SubHeading>
      <UL
        items={[
          <>
            <B>Senior.</B> Top of the waterfall. Pays close to par
            across the common outcome range. Lowest expected return
            and lowest variance. Payoff profile resembles an
            investment-grade bond.
          </>,
          <>
            <B>Mezzanine.</B> Middle of the waterfall. Pays through
            approximately the 68th-percentile outcome, then tapers to
            zero. Moderate expected return with non-trivial variance.
            Payoff profile resembles a call spread.
          </>,
          <>
            <B>Junior.</B> Bottom of the waterfall. Pays only when the
            basket clears the upper attach point. Highest expected
            return and highest variance. Payoff profile resembles a
            deep out-of-the-money call.
          </>,
        ]}
      />
      <SubHeading>Rationale</SubHeading>
      <P>
        A basket&apos;s terminal NAV is a distribution rather than a
        single value. Tranching partitions that distribution into
        three non-overlapping claims with differentiated risk/return
        profiles. By construction, the sum of the three tranche claims
        equals the underlying basket.
      </P>
      <SubHeading>Tranche detail page</SubHeading>
      <P>
        Each basket has a tranche detail page linked from its basket
        card. The page displays the attach and detach points as NAV
        percentiles, the current quote for each tranche kind, the
        implied APY, the remaining face-budget capacity, and the
        risk-engine breakdown for the order size being evaluated.
      </P>
    </>
  );
}

function TrWaterfall() {
  return (
    <>
      <P>
        Attach points are derived from the basket&apos;s terminal-NAV
        distribution, approximated as Normal(μ, σ²), where μ is the
        current weighted NAV and σ is the basket&apos;s implied
        volatility over time-to-resolution. Tranches attach at{" "}
        <Code>K1 = μ</Code> and <Code>K2 = μ + σ</Code>:
      </P>
      <UL
        items={[
          <>
            <B>Senior</B> claims <Code>[0, K1]</Code>. Pays full face
            when terminal NAV ≥ K1; pro-rates below.
          </>,
          <>
            <B>Mezzanine</B> claims <Code>[K1, K2]</Code>. Pays
            linearly from zero at K1 to full face at K2.
          </>,
          <>
            <B>Junior</B> claims <Code>[K2, 1]</Code>. Pays zero below
            K2 and rises linearly to full face at NAV = 1.
          </>,
        ]}
      />
      <SubHeading>Example</SubHeading>
      <P>
        Assume a basket with μ = 0.50 and σ = 0.18, giving attach
        points K1 = 0.50 and K2 = 0.68. The following table shows
        terminal payouts per $1 face:
      </P>
      <Table
        cols={["Terminal NAV", "Senior", "Mezzanine", "Junior"]}
        rows={[
          ["0.30", "0.60",  "0.00",  "0.00"],
          ["0.50", "1.00",  "0.00",  "0.00"],
          ["0.60", "1.00",  "0.56",  "0.00"],
          ["0.68", "1.00",  "1.00",  "0.00"],
          ["0.85", "1.00",  "1.00",  "0.53"],
          ["1.00", "1.00",  "1.00",  "1.00"],
        ]}
      />
      <P>
        Senior is paid in full whenever terminal NAV clears K1.
        Mezzanine begins accruing payout above K1 and reaches full
        face at K2. Junior remains at zero below K2 and accrues
        linearly up to NAV = 1.
      </P>
    </>
  );
}

function TrPricing() {
  return (
    <>
      <P>
        A tranche is a call spread on terminal basket NAV. Under the
        Normal approximation <Code>NAV ~ Normal(μ, σ²)</Code>, fair
        value per $1 face is the spread of two call prices:
      </P>
      <CodeBlock>
        {`fair(A, D) = [ C(μ,σ,A) − C(μ,σ,D) ] / (D − A)
C(μ,σ,K)   = σ · φ(z) + (μ − K) · Φ_c(z)     where z = (K − μ)/σ`}
      </CodeBlock>
      <P>
        <Code>fair(A, D)</Code> is the fair value per $1 face of a
        tranche with attach <Code>A</Code> and detach <Code>D</Code>.
        This corresponds to the price a risk-neutral buyer would pay
        given a perfect hedge. Senior uses <Code>[0, K1]</Code>,
        mezzanine <Code>[K1, K2]</Code>, and junior{" "}
        <Code>[K2, 1]</Code>.
      </P>
      <SubHeading>Ask construction</SubHeading>
      <P>
        The ask anchors to fair value and discounts to a kind-specific
        target APY:
      </P>
      <CodeBlock>
        {`ask        = fair / (1 + target_apy · τ)
target_apy = base[kind] + slope[kind] · σ     (clamped to max[kind])`}
      </CodeBlock>
      <P>
        <Code>τ</Code> is time-to-resolution in years.{" "}
        <Code>target_apy</Code> increases with basket volatility and
        with the convexity of the tranche kind. The{" "}
        <Code>base</Code>, <Code>slope</Code>, and <Code>max</Code>{" "}
        constants are internal calibrations. Quoted yields are
        constrained to the published ranges below.
      </P>
      <SubHeading>Target APY ranges</SubHeading>
      <Table
        cols={["Kind", "Target APY (annualised)", "Characteristics"]}
        rows={[
          ["Senior",    "3–12%",   "Narrow range near par. Modest pickup for higher-volatility baskets."],
          ["Mezzanine", "12–45%",  "Yield compensation for covering the middle of the distribution."],
          ["Junior",    "35–120%", "Deep-OTM yield range, calibrated to compensate for the expected-loss profile."],
        ]}
      />
      <P>
        Displayed APY is annualised relative to the
        time-to-resolution. A tranche with a 28-day window quoting
        10% APY is priced such that a hold-to-maturity purchase
        earns the discount implied by 10% per annum over that window.
      </P>
    </>
  );
}

function TrRisk() {
  return (
    <>
      <P>
        Each tranche quote is produced by a risk engine in{" "}
        <Code>app/app/tranche/_risk.ts</Code> that adds four
        components on top of the fair-anchored ask. The engine
        estimates hedging cost using the live order book depth of the
        basket&apos;s constituent legs.
      </P>
      <Table
        cols={["Component", "Scales with", "Captures"]}
        rows={[
          ["Market impact", "√(size / hedge_capacity)",      "Order-book walk on underlying legs as exposure is laid off."],
          ["Warehouse",     "(1 − hedge_cap / face) × CoC",   "Residual tail that cannot be hedged linearly; held on inventory at a cost of capital."],
          ["Inventory",     "σ × √τ",                        "Vega and theta drift on the hedged book over time-to-resolution."],
          ["Tail premium",  "(tokens × capitalAtRisk) / USDC","Convex gamma cost applicable to mezzanine and junior positions."],
        ]}
      />
      <SubHeading>Reading the breakdown</SubHeading>
      <P>
        The tranche detail page displays each component as a separate
        line on the quote breakdown. A component that dominates the
        total (for example, market impact exceeding the sum of
        warehouse, inventory, and tail) indicates the order size is
        large relative to displayed depth. Reducing size typically
        improves the all-in price.
      </P>
      <SubHeading>Hedging profile</SubHeading>
      <P>
        A senior write is approximately linear: the desk can short
        the underlying legs at pre-attach prices and hedge most of
        the resulting exposure. A junior write is non-linear because
        the payoff activates only above K2, leaving the desk with
        meaningful gamma. As a result, the warehouse and tail
        components dominate junior quotes, and a single basket can
        produce materially different quotes across the three kinds
        at the same notional.
      </P>
    </>
  );
}

function TrCaps() {
  return (
    <>
      <P>
        Face obligation is bounded by available hedge liquidity. Each
        order is subject to a face-budget cap computed from the
        basket&apos;s live order-book depth:
      </P>
      <CodeBlock>
        {`maxUsdc = hedgeCapacity × FACE_BUDGET[kind] × marketPrice
FACE_BUDGET = { senior: 3.0, mezz: 1.5, junior: 0.75 }`}
      </CodeBlock>
      <P>
        Senior receives the largest multiplier because senior face is
        the most hedgeable linearly. Junior receives the smallest
        multiplier because a junior write produces convex inventory
        that must be carried on the book.
      </P>
      <SubHeading>Cap-trip behaviour</SubHeading>
      <P>
        Orders exceeding the cap display{" "}
        <Code>Insufficient liquidity — max $X</Code> and the submit
        action is disabled until the size is reduced. A secondary
        kind-specific fee block (senior 20%, mezzanine 35%, junior
        50% of notional) prevents submission when the computed fee
        exceeds those thresholds, producing the same UX as a cap
        trip.
      </P>
      <SubHeading>Mitigations</SubHeading>
      <UL
        items={[
          <>
            <B>Split the order.</B> Submit a smaller tranche position,
            allow book depth to replenish, and re-quote. The cap is
            evaluated per order against a fresh order-book snapshot.
          </>,
          <>
            <B>Select a less convex kind.</B> If a junior order is
            capped, senior or mezzanine on the same basket carry
            higher multipliers against the same depth.
          </>,
          <>
            <B>Select a different window.</B> Long-window baskets may
            have deeper underlying order books than short-window
            baskets nearing resolution at the same tier.
          </>,
        ]}
      />
    </>
  );
}

function PpnConcept() {
  return (
    <>
      <P>
        A principal-protected note allocates a USDC deposit across two
        sleeves: a <B>vault slice</B> that earns yield until maturity
        and a <B>basket slice</B> that holds a market basket position.
        The vault slice is sized so its projected compounded value at
        maturity equals the original deposit. The residual USDC funds
        the basket slice.
      </P>
      <SubHeading>Floor and ceiling</SubHeading>
      <UL
        items={[
          <>
            <B>Floor target.</B> The vault sleeve is sized toward full
            deposit recovery at maturity, so the note&apos;s floor does
            not depend on the basket settling above zero. Subject to
            vault solvency and redemption availability.
          </>,
          <>
            <B>Ceiling.</B> The basket slice is bounded by{" "}
            <Code>basketTokens × $1</Code>, realised only if every leg
            resolves YES. The expected outcome is close to the
            basket&apos;s prevailing weighted NAV.
          </>,
        ]}
      />
      <SubHeading>Use cases</SubHeading>
      <UL
        items={[
          <>
            Prediction-market exposure with a known maturity date and
            a bounded downside.
          </>,
          <>
            Thematic basket exposure without committing the full
            deposit to market risk.
          </>,
          <>
            Yield sleeve that tracks the best available USDC lending
            venue rather than a fixed protocol.
          </>,
        ]}
      />
      <SubHeading>Opening a note</SubHeading>
      <OL
        items={[
          <>
            Select a basket from the market basket picker. Tier choice
            determines the shape of the upside.
          </>,
          <>
            Enter the deposit size. The UI updates the vault/basket
            split in real time.
          </>,
          <>
            Select a maturity between 7 and 365 days. Longer
            maturities produce a larger basket slice at a given APY.
          </>,
          <>
            Review the payoff preview: floor, expected, and maximum
            payout, together with a payoff curve across terminal NAV.
          </>,
          <>
            Confirm the deposit. The note is recorded in the portfolio
            view.
          </>,
        ]}
      />
      <SubHeading>Maturity and withdrawal</SubHeading>
      <P>
        At maturity, the portfolio view exposes a <B>withdraw</B>{" "}
        action. Withdrawal unwinds both sleeves atomically: the vault
        slice is redeemed at its matured value, the basket slice is
        redeemed at the prevailing NAV, and the combined USDC is
        credited to the wallet balance. Early withdrawal is not
        supported in the current hackathon build.
      </P>
    </>
  );
}

function PpnSplit() {
  return (
    <>
      <P>
        The deposit split is determined by three inputs: the prevailing
        vault APY, the note&apos;s maturity, and the deposit size. The
        split is computed deterministically from the vault&apos;s
        compounding growth:
      </P>
      <CodeBlock>
        {`dailyRate  = apy / 365
growth     = (1 + dailyRate)^days
vaultPct   = 1 / growth
basketPct  = 1 − vaultPct`}
      </CodeBlock>
      <P>
        <Code>vaultPct</Code> is the fraction of the deposit that, when
        compounded at the given APY over the note&apos;s window,
        returns to 1. The remainder is allocated to the basket sleeve.
      </P>
      <SubHeading>Examples</SubHeading>
      <Table
        cols={["Vault APY", "Maturity (days)", "Vault slice", "Basket slice (of $1,000)"]}
        rows={[
          ["6%",  "30",  "99.51%", "$4.92"],
          ["6%",  "90",  "98.53%", "$14.69"],
          ["6%",  "180", "97.08%", "$29.18"],
          ["6%",  "365", "94.34%", "$56.60"],
          ["12%", "180", "94.36%", "$56.35"],
          ["12%", "365", "89.29%", "$107.14"],
        ]}
      />
      <P>
        Short maturities against modest APYs produce small basket
        slices. Longer maturities against higher APYs produce
        substantially larger basket slices.
      </P>
      <SubHeading>Levers</SubHeading>
      <UL
        items={[
          <>
            <B>Maturity.</B> At a given APY, doubling the window
            approximately doubles the basket slice.
          </>,
          <>
            <B>Vault APY.</B> Higher APY reduces the vault sleeve and
            increases the basket slice. Higher APY venues may carry
            additional credit and liquidity risk (see{" "}
            <Code>Yield routing</Code>).
          </>,
          <>
            <B>Tier.</B> The tier of the selected basket sets the
            token count per dollar. A Low-tier basket near $0.05 NAV
            purchases roughly 20× as many tokens per dollar as a
            High-tier basket near $0.95 NAV, with a correspondingly
            higher ceiling.
          </>,
        ]}
      />
    </>
  );
}

function PpnPayoff() {
  return (
    <>
      <P>
        The payoff preview exposes three headline values and a payoff
        curve plotted against terminal basket NAV:
      </P>
      <CodeBlock>
        {`floor     = deposit                              (basket → $0)
expected  = deposit − structuringFee                (basket at fair NAV)
max       = deposit + basketAmt × (1/nav − 1)       (basket → $1/token)`}
      </CodeBlock>
      <P>
        <B>Floor</B> is the deposit returned by the vault sleeve in
        isolation. <B>Expected</B> assumes the basket settles at its
        current fair NAV, net of the structuring fee. <B>Max</B> is
        realised when every basket leg resolves YES.
      </P>
      <SubHeading>Example</SubHeading>
      <P>
        A $1,000 deposit for 180 days at a 6% vault APY, paired with a
        Low-tier basket at NAV ≈ $0.05:
      </P>
      <UL
        items={[
          <>
            Vault slice: 97.08% of $1,000 = $970.82, compounding back
            to $1,000 at maturity.
          </>,
          <>
            Basket slice: $29.18 at NAV $0.05 ≈ 583.6 tokens net of
            fees.
          </>,
          <>
            <B>Floor</B>: $1,000. <B>Expected</B> at basket NAV 0.05:
            approximately $1,000. <B>Max</B> if basket → 1.0:
            $1,000 + 583.6 × (1 − 0.05) = $1,554.40, a 55.4% return on
            deposit.
          </>,
        ]}
      />
      <P>
        The same deposit against a High-tier basket at NAV ≈ $0.95
        produces a floor of $1,000 and a maximum of approximately
        $1,000 + 30.7 × (1 − 0.95) ≈ $1,001.50. Token count per
        dollar is near 1, so the basket contribution to the ceiling is
        negligible.
      </P>
      <SubHeading>Payoff curve</SubHeading>
      <P>
        The SVG curve plots terminal PPN payout as a function of
        terminal basket NAV. It is flat at <Code>floor</Code> until
        the break-even NAV and rises linearly to <Code>max</Code> at
        basket NAV = 1. Steeper curves correspond to more convex
        notes; flatter curves correspond to near-par notes.
      </P>
      <SubHeading>Tier selection</SubHeading>
      <UL
        items={[
          <>
            <B>Low-tier.</B> Maximum upside per dollar of deposit.
            Token count per dollar is highest at NAV near $0.05.
          </>,
          <>
            <B>High-tier.</B> Near-par note. Basket NAV is close to
            $1, so the basket slice contributes minimal upside.
          </>,
        ]}
      />
    </>
  );
}

function PpnRouting() {
  return (
    <>
      <P>
        Each PPN routes its vault slice to the highest-APY USDC
        lending venue that passes the backend&apos;s verification
        rules. The routing decision is surfaced on the PPN page.
      </P>
      <SubHeading>Data source</SubHeading>
      <P>
        The <B>Yield Routing</B> block on the PPN page reads from the
        backend aggregator <Code>GET /api/vaults/yields</Code>. The
        aggregator pulls a public yields dataset every five minutes,
        filters to verified single-asset mock-USDC lending venues with TVL
        above $100k, and returns the top five by APY. Each row
        carries a <Code>live / estimated</Code> freshness flag.
      </P>
      <SubHeading>Selection rules</SubHeading>
      <UL
        items={[
          <>Single-asset USDC pools only; multi-asset LP pools are excluded.</>,
          <>Sui local mode only.</>,
          <>Minimum $100k TVL to exclude dust and newly launched pools.</>,
          <>
            Protocol slug matched against an internal allowlist of
            lending protocols; top-TVL pools are used as back-fill
            when the allowlist produces fewer than five entries.
          </>,
          <>
            Top five results returned, ranked by APY, with the most
            recent snapshot ordered first.
          </>,
        ]}
      />
      <SubHeading>Cache behaviour</SubHeading>
      <P>
        The aggregator caches upstream results for five minutes. If an
        upstream fetch fails, the route returns the most recent
        successful snapshot with <Code>cache_stale: true</Code>. When
        no successful fetch has occurred (for example during cold
        boot), the route returns an{" "}
        <Code>estimated</Code> fallback so deposit flows remain
        available.
      </P>
      <SubHeading>Interpreting the block</SubHeading>
      <P>
        The top row indicates the venue selected for the vault slice.
        Remaining rows list ranked alternatives. A{" "}
        <Code>live</Code> badge indicates the APY originated from a
        successful upstream fetch within the cache window.{" "}
        <Code>estimated</Code> indicates the fallback path was used.
      </P>
    </>
  );
}

function DevApi() {
  return (
    <>
      <P>
        All frontend data flows are served by the backend under{" "}
        <Code>backend/</Code>. Every endpoint is rate-limited per IP
        and caches upstream responses. The base URL is configured via{" "}
        <Code>NEXT_PUBLIC_BACKEND_URL</Code>. Endpoints are scoped to
        the hackathon deployment.
      </P>
      <SubHeading>Conventions</SubHeading>
      <UL
        items={[
          <>
            Responses are JSON objects. Errors return{" "}
            <Code>{`{ error: string }`}</Code> with an appropriate HTTP
            status.
          </>,
          <>
            Proxied endpoints include a <Code>fetched_at</Code> ISO
            timestamp and, where applicable, a <Code>cache_stale</Code>{" "}
            flag.
          </>,
          <>
            Rate limits: general endpoints 60 req/min/IP, portfolio
            endpoints 10 req/min/IP. Throttled requests return 429 with
            a <Code>Retry-After</Code> header.
          </>,
        ]}
      />
      <SubHeading>Markets</SubHeading>
      <Endpoint
        method="GET"
        path="/api/markets"
        description="Active market universe. Proxied and cached from the upstream prediction-market API."
        params={[
          ["limit",  "number", "Default 20, max 20000."],
          ["active", "bool",   "Default true."],
        ]}
        responseNote="{ markets: Market[], fetched_at, cache_stale }"
      />
      <Endpoint
        method="GET"
        path="/api/markets/orderbooks"
        description="Batched CLOB snapshot. 3-second cache, top 25 levels per side."
        params={[["token_ids", "string", "Comma-separated, max 25 ids per request."]]}
        responseNote="{ books: Record<tokenId, { bids, asks }>, fetched_at }"
      />
      <CodeBlock>
        {`curl "https://api.example.com/api/markets?limit=200&active=true"
curl "https://api.example.com/api/markets/orderbooks?token_ids=<id1>,<id2>"`}
      </CodeBlock>
      <SubHeading>Vaults</SubHeading>
      <Endpoint
        method="GET"
        path="/api/vaults/yields"
        description="Ranked USDC lending venues. Cached 5 min. Always returns five rows."
        params={[]}
        responseNote="{ sources: VaultRow[], best: VaultRow, fetched_at, cache_stale }"
      />
      <CodeBlock>
        {`curl "https://api.example.com/api/vaults/yields"

// Example row shape
{
  name: "NAVI",
  slug: "navi-lending",
  apy: 0.0518,
  tvl_usd: 4350000,
  source: "live"    // or "estimated"
}`}
      </CodeBlock>
      <SubHeading>PPN</SubHeading>
      <Endpoint
        method="POST"
        path="/api/ppn/deposit"
        description="Open a demo PPN position."
        params={[
          ["bundle_id",      "string", "Basket id for the basket slice."],
          ["wallet_address", "string", "Depositor wallet (base58)."],
          ["amount_usdc",    "number", "Total deposit."],
          ["maturity_days",  "number", "7–365."],
        ]}
        responseNote="{ vault_id, floor, expected, max, split: { vault_pct, basket_pct } }"
      />
      <Endpoint
        method="GET"
        path="/api/ppn/portfolio/:walletAddress"
        description="All demo PPN positions for a wallet."
        params={[]}
        responseNote="{ positions: PpnPosition[] }"
      />
      <Endpoint
        method="POST"
        path="/api/ppn/withdraw/:vaultId"
        description="Redeem a matured demo PPN. Returns the summed vault + basket payout."
        params={[]}
        responseNote="{ payout_usdc, breakdown: { vault, basket } }"
      />
      <SubHeading>Distribution Markets</SubHeading>
      <Endpoint
        method="GET"
        path="/api/distribution/candidates"
        description="Live distribution-market launch candidates discovered from liquid market groups with CLOB-implied reference curves."
        params={[]}
        responseNote="{ candidates: DistributionCandidate[], funnel, fetched_at }"
      />
      <Endpoint
        method="POST"
        path="/api/distribution/quote"
        description="Normalize and quote a submitted target curve against the live reference curve, returning target-reference payouts and required collateral."
        params={[
          ["candidate_id", "string", "Live distribution candidate id."],
          ["weights", "number[]", "One probability weight per live band."],
          ["collateral_usdc", "number", "USDC collateral amount."],
        ]}
        responseNote="{ quote: DistributionQuote }"
      />
      <Endpoint
        method="POST"
        path="/api/distribution/launch-plan"
        description="Build a local launch plan for the selected candidate."
        params={[
          ["candidate_id", "string", "Live distribution candidate id."],
        ]}
        responseNote="{ plan: DistributionLaunchPlan }"
      />
      <SubHeading>Error shapes</SubHeading>
      <P>
        Validation failures return 400 with{" "}
        <Code>{`{ error: "invalid ‘maturity_days’: must be 7–365" }`}</Code>.
        Rate limits return 429 with a <Code>Retry-After</Code> header.
        Upstream failures return 502 and leave the client free to fall
        back on the last good cached snapshot.
      </P>
    </>
  );
}

function DevRepo() {
  return (
    <>
      <P>
        The repository is a monorepo with three top-level packages.
        Each package has an independent <Code>package.json</Code> or
        <Code>Cargo.toml</Code> and can be built in isolation. Shared
        types are consumed via relative imports.
      </P>
      <CodeBlock>
        {`app/          Next.js frontend (pages, UI state, reducers)
backend/      Express service (market proxy, vault aggregator, PPN demo)
pelagos_sui/ Sui Move package (testnet deployment)`}
      </CodeBlock>
      <SubHeading>Frontend layout</SubHeading>
      <CodeBlock>
        {`app/
  app/
    page.tsx              // Landing
    market baskets/       // Basket grid and detail
    tranche/              // Tranche quote + buy/sell
    ppn/                  // PPN builder and portfolio embed
    portfolio/            // Positions + personalization tabs
    docs/                 // Documentation surface
    _components/          // Shared layout components
    _lib/                 // tokens, orderbook, live-baskets, sandbox reducer
  public/                 // Static assets`}
      </CodeBlock>
      <SubHeading>Backend layout</SubHeading>
      <CodeBlock>
        {`backend/
  src/
    index.ts              // Express wiring, rate-limiters
    routes/
      markets.ts          // /api/markets, /api/markets/orderbooks
      vaults.ts           // /api/vaults/yields
      ppn.ts              // /api/ppn/*
      portfolio.ts        // Personalisation + AI portfolio routes
    services/             // Upstream proxies, cache layer
    lib/                  // Shared helpers`}
      </CodeBlock>
      <SubHeading>Local development</SubHeading>
      <CodeBlock>
        {`# frontend
cd app && npm install && npm run dev

# backend
cd backend && npm install && npm run dev

# typecheck
npx tsc --noEmit`}
      </CodeBlock>
      <P>
        Configure the frontend&apos;s backend host by setting{" "}
        <Code>NEXT_PUBLIC_BACKEND_URL</Code> in{" "}
        <Code>app/.env.local</Code>. The backend&apos;s default
        upstream endpoints do not require paid credentials.
      </P>
      <SubHeading>On-chain programs</SubHeading>
      <P>
        The Sui Move package under <Code>pelagos_sui/</Code> is
        deployed to Sui testnet. It exposes mock-USDC minting plus
        prediction-market create, buy, resolve, and claim flows used by
        the local Sui execution harness.
      </P>
    </>
  );
}

function RiskSummary() {
  return (
    <>
      <P>
        The risks documented below describe the protocol&apos;s
        behaviour in a live deployment. The current hackathon
        deployment is on Sui testnet and exposes no real capital to these
        risks; they are documented because any structured-products
        surface should disclose the loss paths inherent to its design.
      </P>
      <SubHeading>NAV risk</SubHeading>
      <P>
        A basket&apos;s NAV is the weighted mean of its legs&apos; YES
        probabilities. When the upstream market re-prices, the basket
        re-prices with it. Market Baskets provide diversification, not
        hedging; directional moves affecting a substantial portion of
        the leg universe propagate to basket NAV.
      </P>
      <P>
        <B>Scenario.</B> A macro event re-prices half of the legs in a
        basket. The basket&apos;s NAV falls from 0.50 to 0.35. A
        position opened at 0.50 incurs an immediate ~30%
        mark-to-market loss; the terminal outcome is a distribution
        centred near the new NAV.
      </P>
      <SubHeading>Convex tail risk (mezzanine and junior)</SubHeading>
      <P>
        Mezzanine and junior tranches are non-linear claims. A junior
        position can move from a positive mark to zero if the basket
        does not clear the upper attach point. The pricing engine
        prices this through a tail premium and constrains capacity
        through a face-budget cap, but the underlying payoff shape is
        intrinsic.
      </P>
      <P>
        <B>Scenario.</B> A Low-tier junior tranche trades at $0.08 per
        $1 face. The basket settles at NAV = 0.04, below the detach
        point. The junior position pays zero at settlement, producing
        a total loss of premium even though the basket itself has a
        positive mark.
      </P>
      <SubHeading>Liquidity risk</SubHeading>
      <P>
        Quotes are derived from the live central limit order book on
        the underlying legs. Orders that are large relative to
        displayed depth produce high slippage and can exceed the 15%
        slippage ceiling, preventing submission. Book depth is also
        the sole input to the tranche face-budget cap, so thin books
        reduce the maximum tranche order size.
      </P>
      <P>
        <B>Scenario.</B> A Long-window Low-tier basket contains legs
        with shallow displayed depth. A $20k senior tranche order is
        reduced to $6k by the face-budget cap and must be split
        across multiple baskets to reach the intended notional.
      </P>
      <SubHeading>Vault risk (PPN)</SubHeading>
      <P>
        Principal protection depends on the solvency and redemption
        availability of the selected USDC lending vault. The routing
        logic selects the highest-APY venue passing the allowlist,
        which is not equivalent to selecting the lowest-risk venue.
        Vault failure or withdrawal suspension impairs the PPN&apos;s
        vault sleeve.
      </P>
      <P>
        <B>Scenario.</B> The routed venue suspends withdrawals ahead
        of a PPN&apos;s maturity. Principal recovery is delayed until
        the venue resumes redemptions; the note&apos;s floor is not
        available on schedule.
      </P>
      <SubHeading>Oracle and settlement risk</SubHeading>
      <P>
        Leg payouts follow the upstream market&apos;s resolution
        oracle. The protocol does not substitute for or override
        upstream resolution. Ambiguous resolutions adjudicated by the
        upstream venue propagate to every Pelagos position that
        references the affected leg.
      </P>
      <SubHeading>Smart-contract risk</SubHeading>
      <P>
        A live deployment carries the standard risks associated with
        on-chain programs: bugs in settlement logic, upgrade-authority
        compromise, and oracle integration errors. The programs
        included in the repository target Sui testnet and have not
        been audited.
      </P>
      <SubHeading>Operational risk</SubHeading>
      <P>
        Backend outages freeze quote generation and may delay deposit
        or redeem flows until cached data is refreshed. The UI
        degrades to the most recent cached snapshot, which may be
        stale relative to the live underlying market.
      </P>
    </>
  );
}

function FaqAll() {
  return (
    <>
      <Faq
        q="Is real capital used in the application?"
        a="No. The application is deployed to Sui testnet only and all flows use mock assets. No real capital is routed through the protocol."
      />
      <Faq
        q="Will the protocol be deployed to mainnet?"
        a="No. The repository will remain available as a reference, but there are no plans to deploy to mainnet, issue a token, or continue maintenance after the hackathon."
      />
      <Faq
        q="Who built the project?"
        a="A hackathon team building Pelagos as a Sui testnet structured prediction-market prototype."
      />
      <Faq
        q="How many baskets are there?"
        a="Six. The basket universe is a 2×3 grid of tiers (High, Low) and resolution windows (Short, Med, Long). Baskets are regenerated from the active upstream market universe on every refresh."
      />
      <Faq
        q="Can a basket position be closed before resolution?"
        a="Yes. Market Baskets are bidirectional. The basket detail page exposes a sell panel that walks the bid side of the underlying order book and applies an adverse-selection premium."
      />
      <Faq
        q="Can a tranche position be closed before resolution?"
        a="Not in the current hackathon build. Tranche sells involve non-linear hedging dynamics that differ from basket sells; a secondary market is a post-hackathon roadmap item. Market Baskets remain bidirectional."
      />
      <Faq
        q="What happens when an upstream market is delisted?"
        a="The corresponding leg is removed from the basket on the next refresh and the remaining weights are renormalised to sum to 1. No synthetic leg is substituted."
      />
      <Faq
        q="Why does a tranche order report 'insufficient liquidity'?"
        a="The order size exceeds the face-budget cap computed from live order-book depth and the tranche kind. Reduce size, select a less convex kind (senior or mezzanine in place of junior), or route the order to a basket with deeper underlying books."
      />
      <Faq
        q="Why is my PPN's basket slice small?"
        a="Short-dated PPNs routed to modest-APY vaults allocate most of the deposit to the vault sleeve to compound back to par. Select a longer maturity or a higher-APY vault to increase the basket slice."
      />
      <Faq
        q="How is the PPN floor sized?"
        a="The vault slice is sized so projected compounding at the selected APY returns the deposit at maturity. It is not risk-free; vault solvency and redemption availability still apply."
      />
      <Faq
        q="Where do slippage values come from?"
        a="Every quote walks the live order book via the backend. Legs without a live token fall back to a volume-proxy curve. Quoted slippage represents the projected book walk at the specified size."
      />
      <Faq
        q="What is the adverse-selection premium applied to sells?"
        a="A premium on basket sell quotes proportional to sqrt(size / market depth). It compensates liquidity providers for the information content implicit in a large sell order. It is negligible on small orders and becomes material on large orders against thin books."
      />
      <Faq
        q="How often does the vault APY refresh?"
        a="The backend aggregator caches the upstream snapshot for five minutes. The PPN page surfaces the cache status via a live / estimated badge per row."
      />
      <Faq
        q="Can the same basket back multiple products simultaneously?"
        a="Yes. A single basket id can support a direct market basket position, risk slice positions (senior, mezzanine, junior), and a PPN reference at the same time. The portfolio view groups these positions by basket id."
      />
      <Faq
        q="Why are the tranche attach points set at μ and μ+σ?"
        a="Percentile-based attach points maintain meaningful separation across baskets of different volatility. Under the Normal approximation, senior covers the full pre-median range, mezzanine covers approximately 34 percentile points above the median, and junior covers the tail past the first standard deviation."
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
