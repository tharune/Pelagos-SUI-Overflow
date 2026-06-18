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
          /* ===== Theme variables — "Tidal" (Sui Ocean + aqua on deep sea) ===== */
          :root {
            --c-bg: #04121e;
            --c-surface: #07182a;
            --c-card: #0a1f33;
            --c-card-hover: #0f2944;
            --c-card-gradient: linear-gradient(135deg, rgba(10, 31, 51, 0.72) 0%, rgba(4, 18, 30, 0.86) 100%);
            --c-card-gradient-hover: linear-gradient(160deg, rgba(15, 41, 68, 0.94) 0%, rgba(6, 22, 38, 0.96) 100%);
            --c-card-gradient-strong: linear-gradient(135deg, rgba(10, 31, 51, 0.88) 0%, rgba(4, 18, 30, 0.96) 100%);
            --c-panel-gradient: linear-gradient(180deg, rgba(10, 31, 51, 0.9) 0%, rgba(4, 18, 30, 0.96) 100%);
            --c-border: rgba(110, 200, 240, 0.12);
            --c-border-hover: rgba(125, 220, 255, 0.24);
            --c-border-strong: rgba(125, 220, 255, 0.30);
            --c-text-primary: #eef4fc;
            --c-text-secondary: #a3bbd6;
            --c-text-muted: #7d93a9;
            --c-text-strong: #f5f9fe;
            --c-text-subtle: #c0cfe0;
            --c-text-dim: #98aabf;
            --c-header-bg: rgba(4, 18, 30, 0.84);
            --c-page-glow: rgba(77, 162, 255, 0.13);
            --c-scrollbar-thumb: rgba(125, 220, 255, 0.18);
            --c-scrollbar-thumb-hover: rgba(125, 220, 255, 0.34);
            --c-edge-fade: #04121e;
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
            --c-border: rgba(77, 162, 255, 0.22);
            --c-border-hover: rgba(77, 162, 255, 0.45);
            --c-border-strong: rgba(77, 162, 255, 0.35);
            --c-text-primary: #0a0f17;
            --c-text-secondary: #3a4658;
            --c-text-muted: #5a6678;
            --c-text-strong: #0a0f17;
            --c-text-subtle: #232b38;
            --c-text-dim: #3a4658;
            --c-header-bg: rgba(244, 246, 249, 0.88);
            --c-page-glow: rgba(77, 162, 255, 0.14);
            --c-scrollbar-thumb: rgba(77, 162, 255, 0.26);
            --c-scrollbar-thumb-hover: rgba(77, 162, 255, 0.46);
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
          input[type=range] { accent-color: #4da2ff; }

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
