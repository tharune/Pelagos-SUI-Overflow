"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { C, FD } from "../_lib/tokens";
import { ThemeToggle } from "../_lib/theme";

const NAV_LEFT = [
  { id: "portfolio", label: "Portfolio",      href: "/app/portfolio" },
  { id: "basket",    label: "Market Baskets", href: "/app/basket" },
  { id: "tranche",   label: "Risk Slices",    href: "/app/tranche" },
  { id: "ppn",       label: "Protected Notes", href: "/app/ppn" },
  { id: "distribution", label: "Distribution Markets", href: "/app/distribution" },
  { id: "docs",      label: "About",          href: "/app/docs" },
];

function PelagosMark() {
  return (
    <span
      aria-hidden
      style={{
        width: 24,
        height: 24,
        borderRadius: 8,
        display: "inline-grid",
        placeItems: "center",
        background: `linear-gradient(145deg, ${C.tealLight}24, ${C.blue}10)`,
        border: `0.5px solid ${C.tealLight}55`,
        boxShadow: `0 0 18px ${C.tealLight}18`,
        flexShrink: 0,
      }}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
        <path d="M3.5 13.4C5.6 10.9 7.8 9.7 10 9.7c2.6 0 3.7 2.4 6 2.4 1.6 0 2.8-.7 4.5-2.3" stroke={C.tealLight} strokeWidth="2" strokeLinecap="round" />
        <path d="M3.5 9.1C5.6 6.6 7.8 5.4 10 5.4c2.6 0 3.7 2.4 6 2.4 1.6 0 2.8-.7 4.5-2.3" stroke={C.teal} strokeWidth="2" strokeLinecap="round" opacity="0.95" />
        <path d="M5 18h14" stroke="#bae6fd" strokeWidth="1.7" strokeLinecap="round" opacity="0.95" />
      </svg>
    </span>
  );
}

export function Header() {
  const pathname = usePathname();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
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
        padding: "0 24px",
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
                  {active && (
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: -18,
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
          <ThemeToggle />
          <ConnectButton variant="header" />
        </div>
      </header>
    </>
  );
}

export function PageFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
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
      <div style={{ position: "relative", zIndex: 1 }}>
        {children}
      </div>
    </main>
  );
}
