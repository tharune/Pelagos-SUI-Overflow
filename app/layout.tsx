import "@mysten/dapp-kit/dist/index.css";
import { WalletProviders } from "./_providers/WalletProviders";
import { ThemeProvider, THEME_BOOTSTRAP_SCRIPT } from "./app/_lib/theme";
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <title>Pelagos · Structured Predictions</title>
        <link rel="icon" type="image/svg+xml" href="/pelagos_mark.svg" />
        <link rel="apple-touch-icon" href="/pelagos_mark.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
        {/* Apply the saved theme before React hydrates — avoids a flash of
            the wrong palette on first paint. */}
        <Script
          id="theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
        <style>{`
          /* ===== Theme variables ===== */
          :root {
            --c-bg: #050b14;
            --c-surface: #07111f;
            --c-card: #0b1624;
            --c-card-hover: #102033;
            --c-card-gradient: linear-gradient(135deg, rgba(11, 22, 36, 0.72) 0%, rgba(5, 11, 20, 0.86) 100%);
            --c-card-gradient-hover: linear-gradient(160deg, rgba(16, 32, 51, 0.94) 0%, rgba(7, 17, 31, 0.96) 100%);
            --c-card-gradient-strong: linear-gradient(135deg, rgba(11, 22, 36, 0.88) 0%, rgba(5, 11, 20, 0.96) 100%);
            --c-panel-gradient: linear-gradient(180deg, rgba(11, 22, 36, 0.9) 0%, rgba(5, 11, 20, 0.96) 100%);
            --c-border: rgba(125, 211, 252, 0.10);
            --c-border-hover: rgba(125, 211, 252, 0.22);
            --c-border-strong: rgba(125, 211, 252, 0.28);
            --c-text-primary: #eef2f7;
            --c-text-secondary: #89a4c2;
            --c-text-muted: #50657f;
            --c-text-strong: #d6dce6;
            --c-text-subtle: #a3b0c2;
            --c-text-dim: #8d9aad;
            --c-header-bg: rgba(5, 11, 20, 0.84);
            --c-page-glow: rgba(56, 189, 248, 0.12);
            --c-scrollbar-thumb: rgba(125, 211, 252, 0.18);
            --c-scrollbar-thumb-hover: rgba(125, 211, 252, 0.34);
            --c-edge-fade: #050b14;
          }

          [data-theme="light"] {
            --c-bg: #f4f6f9;
            --c-surface: #ffffff;
            --c-card: #ffffff;
            --c-card-hover: #eef1f5;
            --c-card-gradient: #ffffff;
            --c-card-gradient-hover: #f9fbfd;
            --c-card-gradient-strong: #ffffff;
            --c-panel-gradient: #ffffff;
            --c-border: rgba(14, 165, 233, 0.22);
            --c-border-hover: rgba(14, 165, 233, 0.45);
            --c-border-strong: rgba(14, 165, 233, 0.35);
            --c-text-primary: #0b111a;
            --c-text-secondary: #4a5668;
            --c-text-muted: #8a96a8;
            --c-text-strong: #0b111a;
            --c-text-subtle: #2d3544;
            --c-text-dim: #4a5668;
            --c-header-bg: rgba(244, 246, 249, 0.88);
            --c-page-glow: rgba(14, 165, 233, 0.14);
            --c-scrollbar-thumb: rgba(14, 165, 233, 0.26);
            --c-scrollbar-thumb-hover: rgba(14, 165, 233, 0.46);
            --c-edge-fade: #f4f6f9;
          }

          /* ===== Light-mode elevation (soft shadows instead of glow) ===== */
          [data-theme="light"] .pelagos-card {
            box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px rgba(15, 23, 42, 0.04);
          }
          [data-theme="light"] .pelagos-card:hover {
            box-shadow: 0 2px 4px rgba(15, 23, 42, 0.06), 0 8px 20px rgba(15, 23, 42, 0.06);
          }

          /* ===== Base reset + theme-aware chrome ===== */
          *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
          html, body {
            background: var(--c-bg);
            color: var(--c-text-primary);
            font-family: 'Inter', system-ui, sans-serif;
            -webkit-font-smoothing: antialiased;
            transition: background-color 0.2s ease, color 0.2s ease;
            overflow-x: hidden;
          }
          ::-webkit-scrollbar { width: 4px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb {
            background: var(--c-scrollbar-thumb);
            border-radius: 2px;
          }
          ::-webkit-scrollbar-thumb:hover { background: var(--c-scrollbar-thumb-hover); }
          a { color: inherit; }
          input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
          input[type=range] { accent-color: #38bdf8; }

        `}</style>
      </head>
      <body>
        <ThemeProvider>
          <WalletProviders>{children}</WalletProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
