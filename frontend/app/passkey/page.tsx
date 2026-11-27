/**
 * Passkey registration and stream claim page — Issue #70.
 *
 * Non-custodial recipients without a browser-extension wallet can:
 * 1. Register a device passkey bound to their Stellar address.
 * 2. Claim accrued stream funds by authenticating with their passkey.
 *
 * Security notes: see contracts/passkey-signer/src/lib.rs.
 */
"use client";

import React, { useEffect, useState } from "react";
import {
  registerPasskey,
  loginWithPasskey,
  isPasskeyRegistered,
  createSorobanPasskeyTransport,
  extractPublicKeyFromCredential,
} from "../../lib/passkey";
import {
  detectWebAuthnSupport,
  registerAdditionalPasskey,
  revokePasskeyCredential,
  recoverPasskeyAccess,
  type PasskeyCredentialInfo,
  type WebAuthnSupportStatus,
} from "../../lib/passkey-manager";
import { PasskeyCredentialList } from "../../components/passkey/PasskeyCredentialList";
import { PasskeyRegisterPanel } from "../../components/passkey/PasskeyRegisterPanel";
import { PasskeyRecoveryFlow } from "../../components/passkey/PasskeyRecoveryFlow";
import { PasskeyUnsupportedBanner } from "../../components/passkey/PasskeyUnsupportedBanner";
import { useToast } from "../../components/toast";
import { useT } from "../../lib/i18n/provider";

type Step = "idle" | "registering" | "registered" | "logging-in" | "claimed" | "error";
type Tab = "claim" | "devices" | "add" | "recover";

export default function PasskeyPage() {
  const toast = useToast();
  const t = useT();
  const [owner, setOwner] = useState("");
  const [requireUV, setRequireUV] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("claim");
  const [credentials, setCredentials] = useState<PasskeyCredentialInfo[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [governanceApproved, setGovernanceApproved] = useState(false);
  const [support, setSupport] = useState<WebAuthnSupportStatus>({
    supported: true,
    platformAvailable: true,
    roamingAvailable: true,
  });

  useEffect(() => {
    void detectWebAuthnSupport().then(setSupport);
  }, []);

  async function refreshCredentials(addr: string) {
    if (!addr.trim()) return;
    setLoadingCredentials(true);
    try {
      const transport = createSorobanPasskeyTransport();
      const list = await transport.listCredentials(addr.trim());
      setCredentials(list);
    } catch {
      setCredentials([]);
    } finally {
      setLoadingCredentials(false);
    }
  }

  async function handleRegister() {
    if (!owner.trim()) return;
    setStep("registering");
    setMessage(null);
    try {
      const result = await registerPasskey(owner.trim(), requireUV);
      setTxHash(result.txHash);
      setStep("registered");
      const status = t("passkey.registered", { key: result.x.slice(0, 8) });
      setMessage(status);
      toast.success(status);
    } catch (e) {
      setStep("error");
      const status = e instanceof Error ? e.message : String(e);
      setMessage(status);
      toast.error(status);
    }
  }

  async function handleClaim() {
    if (!owner.trim()) return;
    setStep("logging-in");
    setMessage(null);
    try {
      const registered = await isPasskeyRegistered(owner.trim());
      if (!registered) {
        setStep("error");
        const status = t("passkey.notRegistered");
        setMessage(status);
        toast.error(status);
        return;
      }
      const result = await loginWithPasskey(owner.trim());
      setTxHash(result.txHash);
      setStep("claimed");
      const status = t("passkey.claimed");
      setMessage(status);
      toast.success(status);
    } catch (e) {
      setStep("error");
      const status = e instanceof Error ? e.message : String(e);
      setMessage(status);
      toast.error(status);
    }
  }

  const busy = step === "registering" || step === "logging-in";

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Passkey Stream Claims</h1>
      <p style={{ color: "var(--foreground-muted)", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Claim streaming payments from your phone using a device-bound passkey —
        no browser extension wallet required.
      </p>

      <PasskeyUnsupportedBanner support={support} />
      <details style={{ marginBottom: "1.5rem", background: "var(--surface-subtle)", border: "1px solid var(--border-default)", borderRadius: 6, padding: "0.75rem 1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.875rem", color: "var(--foreground-default)" }}>
          Security notes
        </summary>
        <ul style={{ marginTop: "0.5rem", paddingLeft: "1.25rem", fontSize: "0.825rem", color: "var(--foreground-muted)", lineHeight: 1.7 }}>
          <li>
            <strong>Attestation</strong>: We register your P-256 key on-chain without
            verifying attestation. Attestation checks (FIDO MDS3) are recommended for
            high-security deployments and should be done off-chain before calling register.
          </li>
          <li>
            <strong>Assertion</strong>: Every claim performs full WebAuthn Level 3 assertion
            verification on-chain: rpId hash match, user-presence flag, challenge nonce
            (replay prevention), and P-256 ECDSA signature.
          </li>
          <li>
            <strong>Limitations</strong>: On-chain verification cannot confirm which specific
            device produced the credential or that user-verification occurred (unless you
            enable it below).
          </li>
        </ul>
      </details>

      {/* Address input */}
      <label htmlFor="owner-input" style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: "0.875rem" }}>
        Your Stellar address
      </label>
      <input
        id="owner-input"
        type="text"
        placeholder="G… or C…"
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        disabled={busy}
        style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: 6, border: "1px solid var(--border-control)", fontSize: "0.95rem", boxSizing: "border-box", marginBottom: "1rem" }}
        aria-label="Stellar address"
      />

      {/* UV option */}
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={requireUV}
          onChange={(e) => setRequireUV(e.target.checked)}
          disabled={busy}
        />
        Require user verification (PIN / biometric) on every claim
      </label>

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          onClick={handleRegister}
          disabled={busy || !owner.trim()}
          style={btnStyle("primary")}
          aria-label="Register passkey"
        >
          {step === "registering" ? "Registering…" : "Register passkey"}
        </button>
        <button
          onClick={handleClaim}
          disabled={busy || !owner.trim()}
          style={btnStyle("success")}
          aria-label="Claim with passkey"
        >
          {step === "logging-in" ? "Verifying…" : "Claim with passkey"}
        </button>
      </div>

      {/* Status */}
      {message && (
        <div
          style={{
            marginTop: "1.5rem",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            background: step === "error" ? "var(--status-danger-subtle)" : "var(--status-success-subtle)",
            border: `1px solid ${step === "error" ? "var(--status-danger-border)" : "var(--status-success-border)"}`,
            fontSize: "0.875rem",
            color: step === "error" ? "var(--status-danger)" : "var(--status-success)",
          }}
        >
          {message}
        </div>
      )}

      {txHash && (
        <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "var(--foreground-muted)" }}>
          Transaction: <span style={{ fontFamily: "monospace" }}>{txHash}</span>
        </p>
      )}

      {/* Multi-device & recovery navigation */}
      <div
        role="tablist"
        aria-label="Passkey management sections"
        style={{ display: "flex", gap: "0.5rem", marginTop: "1.75rem", marginBottom: "1rem", borderBottom: "1px solid var(--border-default)", paddingBottom: "0.5rem", flexWrap: "wrap" }}
      >
        {(
          [
            ["claim", "Quick Claim"],
            ["devices", "Devices"],
            ["add", "Add Device"],
            ["recover", "Recover Access"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            onClick={() => {
              setActiveTab(key);
              if (key === "devices" || key === "recover") {
                void refreshCredentials(owner);
              }
            }}
            style={{
              padding: "0.4rem 0.85rem",
              borderRadius: 6,
              border: "1px solid var(--border-default)",
              background: activeTab === key ? "var(--accent-strong)" : "var(--surface-subtle)",
              color: activeTab === key ? "var(--foreground-on-accent)" : "var(--foreground-default)",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "devices" && (
        <PasskeyCredentialList
          credentials={credentials}
          loading={loadingCredentials}
          onRevoke={async (credId, allowLast) => {
            const transport = createSorobanPasskeyTransport();
            await revokePasskeyCredential(owner, credId, { confirmed: true, allowLast }, transport);
            toast.success("Passkey device revoked");
            await refreshCredentials(owner);
          }}
        />
      )}

      {activeTab === "add" && (
        <PasskeyRegisterPanel
          support={support}
          disabled={!owner.trim()}
          onRegisterDevice={async (input) => {
            const transport = createSorobanPasskeyTransport();
            const created = await registerAdditionalPasskey(owner, input, {
              transport,
              extractPublicKey: extractPublicKeyFromCredential,
            });
            setCredentials((prev) => [...prev, created]);
            toast.success(`Registered ${created.deviceLabel}`);
          }}
        />
      )}

      {activeTab === "recover" && (
        <div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={governanceApproved}
              onChange={(e) => setGovernanceApproved(e.target.checked)}
            />
            Governance-approved recovery attestation present
          </label>
          <PasskeyRecoveryFlow
            credentials={credentials}
            support={support}
            governanceApproved={governanceApproved}
            onRecover={async (input) => {
              const transport = createSorobanPasskeyTransport();
              const recovered = await recoverPasskeyAccess(
                owner,
                {
                  ...input,
                  existingCredentials: credentials,
                },
                {
                  transport,
                  extractPublicKey: extractPublicKeyFromCredential,
                }
              );
              setCredentials((prev) => [...prev, recovered]);
              toast.success(`Recovered access with ${recovered.deviceLabel}`);
            }}
          />
        </div>
      )}
    </main>
  );
}

function btnStyle(variant: "primary" | "success"): React.CSSProperties {
  return {
    padding: "0.5rem 1.25rem",
    borderRadius: 6,
    background: variant === "success"
      ? "linear-gradient(90deg, var(--status-success-button), var(--status-success-button-end))"
      : "linear-gradient(90deg, var(--accent-strong), var(--accent-secondary-strong))",
    color: variant === "success" ? "var(--foreground-on-success)" : "var(--foreground-on-accent)",
    border: "none",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontWeight: 600,
  };
}
