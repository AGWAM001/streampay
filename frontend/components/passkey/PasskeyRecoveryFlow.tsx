"use client";

import React, { useState } from "react";
import {
  evaluateRecoveryPath,
  type AuthenticatorAttachmentMode,
  type PasskeyCredentialInfo,
  type WebAuthnSupportStatus,
} from "../../lib/passkey-manager";

export interface PasskeyRecoveryFlowProps {
  credentials: PasskeyCredentialInfo[];
  support: WebAuthnSupportStatus;
  governanceApproved: boolean;
  onRecover: (input: {
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    governanceApproved: boolean;
  }) => Promise<void>;
}

export function PasskeyRecoveryFlow({
  credentials,
  support,
  governanceApproved,
  onRecover,
}: PasskeyRecoveryFlowProps) {
  const decision = evaluateRecoveryPath(credentials, governanceApproved);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [attachment, setAttachment] = useState<AuthenticatorAttachmentMode>(
    support.platformAvailable ? "platform" : "cross-platform"
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!decision.allowed || !deviceLabel.trim() || !support.supported) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRecover({
        deviceLabel: deviceLabel.trim(),
        attachment,
        governanceApproved,
      });
      setDeviceLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="passkey-recovery-heading">
      <h2 id="passkey-recovery-heading" style={{ margin: "0 0 0.5rem", fontSize: "1.1rem", fontWeight: 600 }}>
        Recover Passkey Access
      </h2>
      <p style={{ margin: "0 0 0.875rem", fontSize: "0.875rem", color: "var(--foreground-muted)", lineHeight: 1.5 }}>
        Re-bind a replacement authenticator if a device is lost. Contract sign-count monotonicity
        and challenge-expiry guards remain strictly enforced on-chain.
      </p>

      <div
        role={decision.allowed ? "status" : "alert"}
        data-testid="recovery-decision-banner"
        style={{
          marginBottom: "1rem",
          padding: "0.75rem 1rem",
          borderRadius: 8,
          border: `1px solid ${decision.allowed ? "var(--status-info-border)" : "var(--status-danger-border)"}`,
          background: decision.allowed ? "var(--status-info-subtle)" : "var(--status-danger-subtle)",
          color: decision.allowed ? "var(--status-info)" : "var(--foreground-danger-emphasis)",
          fontSize: "0.875rem",
        }}
      >
        <strong>
          {decision.mode === "existing-credential"
            ? "Backup Credential Recovery"
            : decision.mode === "governance-recovery"
            ? "Governance-Approved Recovery"
            : "Recovery Unavailable"}
        </strong>
        <p style={{ margin: "0.25rem 0 0" }}>{decision.reason}</p>
      </div>

      {decision.allowed && (
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.75rem" }}>
          <div>
            <label
              htmlFor="recovery-device-label"
              style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: 4 }}
            >
              Replacement device label
            </label>
            <input
              id="recovery-device-label"
              type="text"
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value)}
              placeholder="e.g. Replacement Phone"
              disabled={submitting || !support.supported}
              style={{
                width: "100%",
                padding: "0.5rem 0.75rem",
                borderRadius: 6,
                border: "1px solid var(--border-control)",
                fontSize: "0.9rem",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: "1rem", fontSize: "0.875rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="recovery-attachment"
                value="platform"
                checked={attachment === "platform"}
                onChange={() => setAttachment("platform")}
                disabled={submitting || !support.platformAvailable}
              />
              Platform
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="recovery-attachment"
                value="cross-platform"
                checked={attachment === "cross-platform"}
                onChange={() => setAttachment("cross-platform")}
                disabled={submitting}
              />
              Roaming Key
            </label>
          </div>

          {error && (
            <div
              role="alert"
              style={{
                padding: "0.65rem 0.85rem",
                borderRadius: 6,
                border: "1px solid var(--status-danger-border)",
                background: "var(--status-danger-subtle)",
                color: "var(--foreground-danger-emphasis)",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={submitting || !deviceLabel.trim() || !support.supported}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 6,
                border: "none",
                background: "var(--accent-secondary-strong)",
                color: "var(--foreground-on-accent)",
                fontWeight: 600,
                fontSize: "0.9rem",
                cursor: submitting || !deviceLabel.trim() || !support.supported ? "not-allowed" : "pointer",
                opacity: submitting || !deviceLabel.trim() || !support.supported ? 0.6 : 1,
              }}
            >
              {submitting ? "Binding replacement device…" : "Bind replacement passkey"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

