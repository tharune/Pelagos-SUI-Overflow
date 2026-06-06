"use client";

/**
 * EvidenceDropzone — the "Brex-style" supporting-document control.
 *
 * A small, reusable upload surface for the transaction send flow: drop or browse
 * receipts / invoices that back the transaction, add an optional note, and the
 * files ride along to the backend on confirm. Controlled by the parent (it owns
 * the `files` array + `memo`) so the send panel can upload them at submit time.
 *
 * Purely presentational + validation — no network. Upload lives in
 * `receipts-client.ts`; the parent calls it after the on-chain action lands.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { C, FM, FS, EASE } from "../_lib/tokens";
import { ACCEPTED_MIME, MAX_RECEIPT_BYTES, fmtBytes } from "../_lib/receipts-client";

function PaperclipIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M14 3v5h5M9 13h6M9 16.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EvidenceDropzone({
  files,
  onChange,
  memo = "",
  onMemoChange,
  disabled = false,
  maxFiles = 6,
  label = "Attach supporting documents",
  hint = "Receipts or invoices that back this transaction — optional, kept as your audit trail",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  memo?: string;
  onMemoChange?: (memo: string) => void;
  disabled?: boolean;
  maxFiles?: number;
  label?: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<(string | null)[]>([]);

  // Object URLs for image thumbnails, regenerated whenever the file set changes.
  useEffect(() => {
    const urls = files.map((f) =>
      f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    );
    setPreviews(urls);
    return () => urls.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const accepted: File[] = [];
      const rejected: string[] = [];
      for (const f of list) {
        if (!ACCEPTED_MIME.includes(f.type)) {
          rejected.push(`${f.name} (unsupported type)`);
        } else if (f.size > MAX_RECEIPT_BYTES) {
          rejected.push(`${f.name} (over 8 MB)`);
        } else if (files.some((e) => e.name === f.name && e.size === f.size)) {
          // de-dupe identical re-adds silently
        } else {
          accepted.push(f);
        }
      }
      const room = Math.max(0, maxFiles - files.length);
      const next = [...files, ...accepted.slice(0, room)];
      if (accepted.length > room) rejected.push(`only ${maxFiles} files allowed`);
      setError(rejected.length ? rejected.join(" · ") : null);
      onChange(next);
    },
    [files, maxFiles, onChange],
  );

  const removeAt = (i: number) => {
    setError(null);
    onChange(files.filter((_, idx) => idx !== i));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            fontFamily: FS,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.textSecondary,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: C.teal, display: "inline-flex" }}><PaperclipIcon size={13} /></span>
          {label}
        </span>
        {files.length > 0 && (
          <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
            {files.length} / {maxFiles}
          </span>
        )}
      </div>

      {/* Drop / browse surface */}
      <button
        type="button"
        disabled={disabled || files.length >= maxFiles}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled && e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 10,
          border: `1px dashed ${dragOver ? C.teal : C.border}`,
          background: dragOver ? `${C.teal}14` : C.card,
          color: C.textSecondary,
          cursor: disabled || files.length >= maxFiles ? "not-allowed" : "pointer",
          textAlign: "left",
          opacity: files.length >= maxFiles ? 0.6 : 1,
          transition: `border-color 0.18s ${EASE}, background 0.18s ${EASE}`,
        }}
        onMouseEnter={(e) => {
          if (!dragOver && files.length < maxFiles)
            (e.currentTarget as HTMLElement).style.borderColor = C.borderHover;
        }}
        onMouseLeave={(e) => {
          if (!dragOver) (e.currentTarget as HTMLElement).style.borderColor = C.border;
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            height: 34,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            color: C.teal,
            flexShrink: 0,
          }}
        >
          <DocIcon size={17} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontFamily: FS, fontSize: 13.5, fontWeight: 500, color: C.textPrimary }}>
            {files.length >= maxFiles ? "Attachment limit reached" : "Drop files or browse"}
          </span>
          <span style={{ fontFamily: FS, fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>
            {hint}
          </span>
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_MIME.join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />

      {error && (
        <span style={{ fontFamily: FS, fontSize: 12, color: C.amber }}>{error}</span>
      )}

      {/* Attached file chips */}
      {files.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {files.map((f, i) => (
            <div
              key={`${f.name}-${f.size}-${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 10px",
                borderRadius: 9,
                border: `1px solid ${C.border}`,
                background: C.surface,
              }}
            >
              {previews[i] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previews[i] as string}
                  alt={f.name}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 6,
                    objectFit: "cover",
                    border: `1px solid ${C.border}`,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 38,
                    height: 38,
                    borderRadius: 6,
                    border: `1px solid ${C.border}`,
                    background: C.tealBg,
                    color: C.tealLight,
                    flexShrink: 0,
                  }}
                >
                  <DocIcon size={18} />
                </span>
              )}
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontFamily: FS,
                    fontSize: 13,
                    fontWeight: 500,
                    color: C.textPrimary,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {f.name}
                </span>
                <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>
                  {f.type.replace("application/", "").replace("image/", "").toUpperCase()} · {fmtBytes(f.size)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => removeAt(i)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  border: `1px solid ${C.border}`,
                  background: "transparent",
                  color: C.textMuted,
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: `color 0.15s ${EASE}, border-color 0.15s ${EASE}`,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color = C.red;
                  (e.currentTarget as HTMLElement).style.borderColor = `${C.red}66`;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color = C.textMuted;
                  (e.currentTarget as HTMLElement).style.borderColor = C.border;
                }}
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Optional audit note */}
      {onMemoChange && files.length > 0 && (
        <textarea
          value={memo}
          onChange={(e) => onMemoChange(e.target.value)}
          placeholder="Add a note for the audit trail (optional) — e.g. what these documents prove"
          rows={2}
          style={{
            width: "100%",
            resize: "vertical",
            padding: "9px 11px",
            borderRadius: 9,
            border: `1px solid ${C.border}`,
            background: C.card,
            color: C.textPrimary,
            fontFamily: FS,
            fontSize: 12.5,
            lineHeight: 1.5,
            outline: "none",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = C.teal;
            e.currentTarget.style.boxShadow = `0 0 0 3px ${C.teal}22`;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = C.border;
            e.currentTarget.style.boxShadow = "none";
          }}
        />
      )}
    </div>
  );
}
