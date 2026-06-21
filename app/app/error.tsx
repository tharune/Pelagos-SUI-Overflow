"use client";

// App Router segment error boundary. Any render crash on a product page (e.g. a
// malformed-but-200 quote that throws inside a chart/legs map) is caught here and
// shown as a clean recoverable screen instead of a blank white page. `reset()`
// re-renders the failed segment so the user can retry without a full reload.

import { C, FD, FS } from "./_lib/tokens";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        minHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "48px 24px",
        textAlign: "center",
        background: C.bg,
      }}
    >
      <div
        style={{
          fontFamily: FD,
          fontSize: 22,
          fontWeight: 600,
          color: C.textPrimary,
        }}
      >
        Something went wrong
      </div>
      <p
        style={{
          fontFamily: FS,
          fontSize: 14,
          lineHeight: 1.6,
          color: C.textMuted,
          maxWidth: 420,
        }}
      >
        This view hit an unexpected error and couldn&apos;t render. Your funds and
        positions are unaffected — try again.
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 4,
          padding: "10px 22px",
          borderRadius: 10,
          border: `0.5px solid ${C.borderStrong}`,
          background: C.teal,
          color: "#fff",
          fontFamily: FS,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
