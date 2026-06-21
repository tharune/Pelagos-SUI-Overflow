"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { HeaderFaucet } from "./HeaderFaucet";
import { TestnetBadge } from "./TestnetBadge";
import { C, FD, FM } from "../_lib/tokens";
import { ThemeToggle } from "../_lib/theme";
import { ModeToggle } from "../_lib/mode";

// Combined IA: Baskets absorbs Risk Slices (side-by-side), and DeepBook absorbs
// Protected Notes (Strategies + Notes tabs). The old /app/tranche and /app/ppn
// routes still resolve for deep links, just not in the primary nav.
const NAV_LEFT = [
  { id: "portfolio",    label: "Portfolio",           href: "/app/portfolio" },
  { id: "distribution", label: "Distribution Markets", href: "/app/distribution" },
  { id: "volatility",   label: "Volatility",          href: "/app/volatility" },
  { id: "deepbook",     label: "Range Strips",            href: "/app/deepbook" },
  { id: "basket",       label: "Baskets",             href: "/app/basket", beta: true },
  { id: "docs",         label: "About",               href: "/app/docs" },
];

function PelagosMark() {
  return (
    <svg aria-hidden viewBox="0 0 95 40" width="40" height="17" fill="none" style={{ flexShrink: 0 }}>
      <path d="M10 10 C28 16 36 30 52 30 C66 30 70 18 82 20" stroke={C.blue} strokeWidth="5" strokeLinecap="round" />
      <path d="M10 30 C28 24 36 10 52 10 C66 10 70 22 82 20" stroke={C.tealLight} strokeWidth="5" strokeLinecap="round" />
      <circle cx="82" cy="20" r="5.5" fill={C.tealLight} />
    </svg>
  );
}

export function Header() {
  const pathname = usePathname();

  return (
    <>
      <style>{`
        .pelagos-nav-link:hover { color: ${C.textPrimary} !important; }
      `}</style>
      <header style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: C.headerBg,
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: `0.5px solid ${C.border}`,
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 min(40px, 6vw)",
        gap: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24, flex: 1, minWidth: 0 }}>
          <Link href="/" aria-label="Pelagos home" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flexShrink: 0 }}>
            <PelagosMark />
            <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, letterSpacing: "0.14em" }}>
              PELAGOS
            </span>
          </Link>

          <nav style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            overflowX: "auto",
            whiteSpace: "nowrap",
            scrollbarWidth: "none",
          }}>
            {NAV_LEFT.map((n) => {
              const active = pathname === n.href || (n.href !== "/app" && pathname?.startsWith(n.href));
              return (
                <Link
                  key={n.id}
                  href={n.href}
                  className="pelagos-nav-link"
                  style={{
                    position: "relative",
                    padding: "4px 0",
                    paddingBottom: 6,
                    fontSize: 13,
                    fontWeight: 400,
                    fontFamily: FD,
                    letterSpacing: "0.01em",
                    textDecoration: "none",
                    color: active ? C.textPrimary : C.textSecondary,
                    transition: "color 0.15s linear",
                  }}
                >
                  {n.label}
                  {"beta" in n && n.beta && (
                    <sup
                      style={{
                        marginLeft: 4,
                        fontFamily: FM,
                        fontSize: 7.5,
                        fontWeight: 600,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: C.tealLight,
                        verticalAlign: "super",
                      }}
                    >
                      beta
                    </sup>
                  )}
                  {active && (
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 1,
                        background: C.tealLight,
                      }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <ModeToggle />
          <ThemeToggle />
          <TestnetBadge />
          <HeaderFaucet />
          <ConnectButton variant="header" />
        </div>
      </header>
    </>
  );
}

export function PageFrame({
  children,
  wide = false,
  zoom,
}: {
  children: React.ReactNode;
  wide?: boolean;
  /** Optional content scale (e.g. 0.8) for pages that read large at 100%. */
  zoom?: number;
}) {
  return (
    <main style={{
      minHeight: "calc(100vh - 56px)",
      width: "100%",
      overflowX: "hidden",
      padding: "36px min(40px, 6vw) 60px",
      maxWidth: wide ? 1760 : 1440,
      margin: "0 auto",
      position: "relative",
    }}>
      <div style={{
        position: "fixed",
        inset: 0,
        background: `radial-gradient(ellipse 80% 50% at 50% -10%, ${C.pageGlow} 0%, transparent 70%)`,
        pointerEvents: "none",
        zIndex: 0,
      }} />
      <div style={{
        position: "relative",
        zIndex: 1,
        ...(zoom ? ({ zoom } as React.CSSProperties) : {}),
      }}>
        {children}
      </div>
    </main>
  );
}
