"use client";

import React, { useState } from "react";
import type {
  AuthenticatorAttachmentMode,
  WebAuthnSupportStatus,
} from "../../lib/passkey-manager";

export interface PasskeyRegisterPanelProps {
  support: WebAuthnSupportStatus;
  disabled?: boolean;
  onRegisterDevice: (input: {
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    requireUV: boolean;
  }) => Promise<void>;
}

export function PasskeyRegisterPanel({
  support,
  disabled = false,
  onRegisterDevice,
}: PasskeyRegisterPanelProps) {
  const [deviceLabel, setDeviceLabel] = useState("");
  const [attachment, setAttachment] = useState<AuthenticatorAttachmentMode>(
    support.platformAvailable ? "platform" : "cross-platform"
  );
  const [requireUV, setRequireUV] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!deviceLabel.trim() || !support.supported) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRegisterDevice({
        deviceLabel: deviceLabel.trim(),
        attachment,
        requireUV,
      });
      setDeviceLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const isDisabled = disabled || submitting || !support.supported;

  return (
    <section aria-labelledby="add-device-heading">
      <h2 id="add-device-heading" style={{ margin: "0 0 0.75rem", fontSize: "1.1rem", fontWeight: 600 }}>
        Register New Authenticator
      </h2>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.875rem" }}>
        <div>
          <label
            htmlFor="device-label-input"
            style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: 4 }}
          >
            Device label
          </label>
          <input
            id="device-label-input"
            type="text"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            placeholder="e.g. MacBook Touch ID or YubiKey 5C"
            disabled={isDisabled}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              fontSize: "0.9rem",
              boxSizing: "border-box",
            }}
          />
        </div>

        <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "0.75rem" }}>
          <legend style={{ fontSize: "0.85rem", fontWeight: 600, padding: "0 0.25rem" }}>
            Authenticator type
          </legend>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="attachment-mode"
                value="platform"
                checked={attachment === "platform"}
                onChange={() => setAttachment("platform")}
                disabled={isDisabled || !support.platformAvailable}
              />
              <span>
                <strong>Platform</strong> — Built-in Touch ID, Face ID, or Windows Hello
                {!support.platformAvailable && " (unavailable on this device)"}
              </span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="attachment-mode"
                value="cross-platform"
                checked={attachment === "cross-platform"}
                onChange={() => setAttachment("cross-platform")}
                disabled={isDisabled}
              />
              <span>
                <strong>Roaming Key</strong> — External USB / NFC hardware key (YubiKey, SoloKey)
              </span>
            </label>
          </div>
        </fieldset>

        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={requireUV}
            onChange={(e) => setRequireUV(e.target.checked)}
            disabled={isDisabled}
          />
          Require user verification (PIN / biometric) on every assertion
        </label>

        {error && (
          <div
            role="alert"
            style={{
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

        <div>
          <button
            type="submit"
            disabled={isDisabled || !deviceLabel.trim()}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: 6,
              border: "none",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 600,
              fontSize: "0.9rem",
              cursor: isDisabled || !deviceLabel.trim() ? "not-allowed" : "pointer",
              opacity: isDisabled || !deviceLabel.trim() ? 0.6 : 1,
            }}
          >
            {submitting ? "Waiting for authenticator…" : "Add passkey device"}
          </button>
        </div>
      </form>
    </section>
  );
}

