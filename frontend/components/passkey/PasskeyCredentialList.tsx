"use client";

import React, { useState } from "react";
import type { PasskeyCredentialInfo } from "../../lib/passkey-manager";

export interface PasskeyCredentialListProps {
  credentials: PasskeyCredentialInfo[];
  loading?: boolean;
  onRevoke: (credId: string, allowLast: boolean) => Promise<void>;
}

function formatUnixSec(ts: number | null): string {
  if (!ts) return "Never";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function PasskeyCredentialList({
  credentials,
  loading = false,
  onRevoke,
}: PasskeyCredentialListProps) {
  const [confirmTarget, setConfirmTarget] = useState<PasskeyCredentialInfo | null>(null);
  const [allowLastConfirmed, setAllowLastConfirmed] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeCount = credentials.filter((c) => c.status === "active").length;

  async function handleConfirmRevoke() {
    if (!confirmTarget) return;
    const isLast = activeCount <= 1;
    if (isLast && !allowLastConfirmed) return;
    setRevokingId(confirmTarget.id);
    setError(null);
    try {
      await onRevoke(confirmTarget.id, isLast && allowLastConfirmed);
      setConfirmTarget(null);
      setAllowLastConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section aria-labelledby="registered-devices-heading">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <h2 id="registered-devices-heading" style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
          Registered Passkeys ({activeCount} active)
        </h2>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: "0.75rem",
            padding: "0.65rem 0.85rem",
            borderRadius: 6,
            border: "1px solid #fca5a5",
            background: "#fef2f2",
            color: "#991b1b",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p role="status" style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          Loading registered credentials…
        </p>
      ) : credentials.length === 0 ? (
        <div
          data-testid="empty-credential-list"
          style={{
            padding: "1.25rem",
            borderRadius: 8,
            border: "1px dashed #d1d5db",
            background: "#f9fafb",
            color: "#4b5563",
            fontSize: "0.9rem",
          }}
        >
          No passkey devices registered for this Stellar address yet.
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}>
          {credentials.map((cred) => {
            const isRevoked = cred.status === "revoked";
            return (
              <li
                key={cred.id}
                data-testid={`credential-item-${cred.id}`}
                style={{
                  padding: "0.875rem 1rem",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  background: isRevoked ? "#f9fafb" : "#ffffff",
                  opacity: isRevoked ? 0.7 : 1,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.95rem" }}>{cred.deviceLabel}</strong>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: 999,
                          background: cred.attachment === "platform" ? "#eff6ff" : "#f5f3ff",
                          color: cred.attachment === "platform" ? "#1d4ed8" : "#6d28d9",
                          border: "1px solid currentColor",
                        }}
                      >
                        {cred.attachment === "platform" ? "Platform" : "Roaming Key"}
                      </span>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: 999,
                          background: isRevoked ? "#fee2e2" : "#dcfce7",
                          color: isRevoked ? "#991b1b" : "#166534",
                        }}
                      >
                        {isRevoked ? "Revoked" : "Active"}
                      </span>
                    </div>
                    <dl style={{ margin: "0.5rem 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.2rem 0.75rem", fontSize: "0.8rem", color: "#4b5563" }}>
                      <dt>Credential ID:</dt>
                      <dd style={{ margin: 0, fontFamily: "monospace" }}>{cred.id.slice(0, 16)}…</dd>
                      <dt>Sign-count:</dt>
                      <dd style={{ margin: 0 }}>{cred.signCount} (monotonic)</dd>
                      <dt>Created:</dt>
                      <dd style={{ margin: 0 }}>{formatUnixSec(cred.createdAt)}</dd>
                      <dt>Last used:</dt>
                      <dd style={{ margin: 0 }}>{formatUnixSec(cred.lastUsedAt)}</dd>
                    </dl>
                  </div>

                  {!isRevoked && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmTarget(cred);
                        setAllowLastConfirmed(false);
                        setError(null);
                      }}
                      disabled={revokingId === cred.id}
                      aria-label={`Revoke ${cred.deviceLabel}`}
                      style={{
                        padding: "0.35rem 0.75rem",
                        borderRadius: 6,
                        border: "1px solid #fca5a5",
                        background: "#fff",
                        color: "#b91c1c",
                        fontSize: "0.825rem",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirmTarget && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="revoke-dialog-title"
          aria-describedby="revoke-dialog-desc"
          data-testid="revoke-confirm-dialog"
          style={{
            marginTop: "1rem",
            padding: "1rem",
            borderRadius: 8,
            border: "1px solid #fca5a5",
            background: "#fef2f2",
          }}
        >
          <h3 id="revoke-dialog-title" style={{ margin: 0, fontSize: "0.95rem", color: "#991b1b" }}>
            Revoke &ldquo;{confirmTarget.deviceLabel}&rdquo;?
          </h3>
          <p id="revoke-dialog-desc" style={{ margin: "0.4rem 0 0.75rem", fontSize: "0.85rem", color: "#7f1d1d" }}>
            This device will no longer be able to sign assertions on-chain.
          </p>

          {activeCount <= 1 && (
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", fontSize: "0.85rem", color: "#7f1d1d", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allowLastConfirmed}
                onChange={(e) => setAllowLastConfirmed(e.target.checked)}
              />
              I understand this is my last active passkey and future recovery will require governance approval.
            </label>
          )}

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={handleConfirmRevoke}
              disabled={revokingId !== null || (activeCount <= 1 && !allowLastConfirmed)}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: 6,
                border: "none",
                background: "#dc2626",
                color: "#fff",
                fontWeight: 600,
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              {revokingId ? "Revoking…" : "Confirm revoke"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmTarget(null);
                setAllowLastConfirmed(false);
              }}
              disabled={revokingId !== null}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                color: "#374151",
                fontWeight: 600,
                fontSize: "0.85rem",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

