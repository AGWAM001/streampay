"use client";

import React from "react";
import type { WebAuthnSupportStatus } from "../../lib/passkey-manager";

export interface PasskeyUnsupportedBannerProps {
  support: WebAuthnSupportStatus;
}

export function PasskeyUnsupportedBanner({ support }: PasskeyUnsupportedBannerProps) {
  if (support.supported && support.platformAvailable) {
    return null;
  }

  const isUnsupported = !support.supported;

  return (
    <section
      role={isUnsupported ? "alert" : "status"}
      aria-live="polite"
      data-testid="webauthn-support-banner"
      style={{
        marginBottom: "1rem",
        padding: "0.875rem 1rem",
        borderRadius: 8,
        border: `1px solid ${isUnsupported ? "var(--status-danger-border)" : "var(--status-warning-border)"}`,
        background: isUnsupported ? "var(--status-danger-subtle)" : "var(--status-warning-subtle)",
        color: isUnsupported ? "var(--foreground-danger-emphasis)" : "var(--status-warning)",
        fontSize: "0.875rem",
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>
        {isUnsupported
          ? "Passkeys are not supported in this browser"
          : "Platform authenticator unavailable"}
      </p>
      <p style={{ margin: "0.35rem 0 0", lineHeight: 1.5 }}>
        {support.reason ??
          "You can still use a roaming USB/NFC security key or connect with Freighter."}
      </p>
    </section>
  );
}

