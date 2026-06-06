"use client";

/**
 * AuditTrail — the verification surface for attached evidence.
 *
 * Reads the sandbox `evidence` map (receipts / invoices attached at send time)
 * and renders it as a per-position audit trail: each position that carries
 * supporting documents gets a "Verified" record with viewable thumbnails. This
 * is the read side of the Brex-style flow — the write side is EvidenceDropzone.
 */
import React from "react";
import { C, FS, FD, FM, EASE } from "../_lib/tokens";
import { fmtBytes, type EvidenceItem } from "../_lib/receipts-client";

const TYPE_LABEL: Record<string, string> = {
  basket: "Market basket",
  tranche: "Risk slice",
  ppn: "Protected note",
  distribution: "Distribution market",
};

function ShieldCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l7 2.8v5.2c0 4.2-3 7.3-7 8.9-4-1.6-7-4.7-7-8.9V5.8L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12.1l2.1 2.1L15 10.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function labelFor(key: string): { type: string; id: string } {
  const [type, ...rest] = key.split(":");
  return { type: TYPE_LABEL[type] ?? "Position", id: rest.join(":") || "—" };
}

export function AuditTrail({
  evidence,
  onRemove,
}: {
  evidence: Record<string, EvidenceItem[]>;
  onRemove?: (key: string, id: string) => void;
}) {
  const groups = Object.entries(evidence).filter(([, items]) => items.length > 0);
  const docCount = groups.reduce((n, [, items]) => n + items.length, 0);

  return (
    <div
      style={{
        background: C.card,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: 20,
        marginTop: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: groups.length ? 18 : 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              color: C.teal,
            }}
          >
            <ShieldCheck size={16} />
          </span>
          <div>
            <div style={{ color: C.textPrimary, fontFamily: FD, fontSize: 15, fontWeight: 600 }}>
              Verification &amp; audit trail
            </div>
            <div style={{ color: C.textMuted, fontFamily: FS, fontSize: 12, marginTop: 1 }}>
              Receipts and invoices attached to your transactions
            </div>
          </div>
        </div>
        {docCount > 0 && (
          <span style={{ color: C.textSecondary, fontFamily: FM, fontSize: 11, whiteSpace: "nowrap" }}>
            {docCount} {docCount === 1 ? "document" : "documents"} · {groups.length}{" "}
            {groups.length === 1 ? "position" : "positions"}
          </span>
        )}
      </div>

      {groups.length === 0 ? (
        <div style={{ color: C.textSecondary, fontFamily: FS, fontSize: 13, lineHeight: 1.55 }}>
          No supporting documents yet. When you deposit, attach receipts or invoices
          to back the transaction — they appear here as your audit trail.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {groups.map(([key, items]) => {
            const { type, id } = labelFor(key);
            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: C.textPrimary, fontFamily: FD, fontSize: 13, fontWeight: 600 }}>
                    {type}
                  </span>
                  <span style={{ color: C.textMuted, fontFamily: FM, fontSize: 11.5 }}>{id}</span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: `${C.green}1f`,
                      color: C.green,
                      fontFamily: FS,
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    <ShieldCheck size={11} /> Verified
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                  {items.map((item) => {
                    const isImage = item.mime.startsWith("image/");
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 11,
                          padding: "9px 11px",
                          borderRadius: 10,
                          border: `1px solid ${C.border}`,
                          background: C.surface,
                          transition: `border-color 0.15s ${EASE}`,
                        }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = C.borderHover)}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = C.border)}
                      >
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`View ${item.filename}`}
                          style={{ flexShrink: 0, display: "inline-flex", borderRadius: 7, overflow: "hidden" }}
                        >
                          {isImage ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.url}
                              alt={item.filename}
                              style={{ width: 40, height: 40, objectFit: "cover", border: `1px solid ${C.border}`, borderRadius: 7, display: "block" }}
                            />
                          ) : (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 40,
                                height: 40,
                                borderRadius: 7,
                                background: C.tealBg,
                                color: C.tealLight,
                                border: `1px solid ${C.border}`,
                              }}
                            >
                              <DocGlyph size={18} />
                            </span>
                          )}
                        </a>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              display: "block",
                              color: C.textPrimary,
                              fontFamily: FS,
                              fontSize: 12.5,
                              fontWeight: 500,
                              textDecoration: "none",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {item.filename}
                          </a>
                          <div style={{ color: C.textMuted, fontFamily: FM, fontSize: 10.5, marginTop: 2 }}>
                            {fmtBytes(item.size)}
                            {item.memo ? <span style={{ color: C.textSecondary }}> · {item.memo}</span> : null}
                          </div>
                        </div>
                        {onRemove && (
                          <button
                            type="button"
                            aria-label={`Remove ${item.filename}`}
                            onClick={() => onRemove(key, item.id)}
                            style={{
                              flexShrink: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 24,
                              height: 24,
                              borderRadius: 6,
                              border: "none",
                              background: "transparent",
                              color: C.textMuted,
                              cursor: "pointer",
                              transition: `color 0.15s ${EASE}`,
                            }}
                            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = C.red)}
                            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = C.textMuted)}
                          >
                            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
