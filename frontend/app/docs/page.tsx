"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useState } from "react";

export default function DocsPage() {
  const [swaggerReady, setSwaggerReady] = useState(false);

  const initSwagger = useCallback(() => {
    const win = window as unknown as {
      SwaggerUIBundle?: (config: Record<string, unknown>) => void;
    };
    if (win.SwaggerUIBundle) {
      win.SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [],
        layout: "BaseLayout",
      });
      setSwaggerReady(true);
    }
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "2rem 1.5rem" }}>
      {/* Swagger UI styles */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-css"
      />

      <Script
        src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"
        onReady={initSwagger}
      />

      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/"
          style={{
            color: "var(--accent-primary)",
            textDecoration: "none",
            fontSize: "0.875rem",
            display: "inline-block",
            marginBottom: "1rem",
          }}
        >
          ← Back to StreamPay App
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "2.25rem", fontWeight: 700, margin: 0 }}>
            ⚡ Accrual Curve API Docs
          </h1>
          <span
            style={{
              background: "var(--surface-subtle)",
              color: "var(--status-info)",
              padding: "0.25rem 0.75rem",
              borderRadius: "9999px",
              fontSize: "0.8125rem",
              fontWeight: 600,
              border: "1px solid var(--border-strong)",
            }}
          >
            OpenAPI 3.1
          </span>
          <a
            href="/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: "var(--accent-secondary-strong)",
              color: "var(--foreground-on-accent)",
              padding: "0.35rem 0.85rem",
              borderRadius: "6px",
              fontSize: "0.8125rem",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Raw openapi.json ↗
          </a>
        </div>
        <p style={{ color: "var(--foreground-muted)", fontSize: "1.05rem", marginTop: "0.5rem" }}>
          Continuous on-the-fly accrual curves computed directly from contract state with ETag
          caching, honest staleness indicators, and shared RPC rate budgeting.
        </p>
      </div>

      {/* Architecture & Protocol Notes */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
          marginBottom: "2.5rem",
        }}
      >
        <div
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--surface-subtle)",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "var(--status-info)" }}>
            1. Computed, Never Stored
          </h3>
          <p style={{ color: "var(--foreground-default)", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Curve points are derived in real-time using the contract’s exact pure math:
            <code style={{ display: "block", margin: "0.5rem 0", background: "var(--surface-subtle)", padding: "0.4rem", borderRadius: "4px" }}>
              streamed(t) = deposit × elapsed / duration
            </code>
            Zero points are persisted in databases or files.
          </p>
        </div>

        <div
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--surface-subtle)",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "var(--status-info)" }}>
            2. State Hash & ETag Caching
          </h3>
          <p style={{ color: "var(--foreground-default)", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Response includes exact <code style={{ color: "var(--status-warning)" }}>X-State-Hash</code> computed as SHA-256 of on-chain state.
            ETag is derived from <code style={{ color: "var(--status-warning)" }}>hash:id:from:to:step</code>. Clients sending
            <code style={{ color: "var(--status-warning)" }}>If-None-Match</code> receive <code style={{ color: "var(--status-success)" }}>304 Not Modified</code> with zero payload.
          </p>
        </div>

        <div
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--surface-subtle)",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "var(--status-info)" }}>
            3. Honest Staleness Headers
          </h3>
          <p style={{ color: "var(--foreground-default)", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Every response discloses exact freshness: <code style={{ color: "var(--status-warning)" }}>X-As-Of-Ledger</code>,
            <code style={{ color: "var(--status-warning)" }}>X-As-Of-Timestamp</code>, and <code style={{ color: "var(--status-warning)" }}>Age</code>. If indexer lag exceeds threshold (&gt;60s), an explicit
            <code style={{ color: "var(--status-danger)" }}>Warning: 199</code> header is emitted.
          </p>
        </div>

        <div
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--surface-subtle)",
            borderRadius: "8px",
            padding: "1.25rem",
          }}
        >
          <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem 0", color: "var(--status-info)" }}>
            4. Shared RPC Budget Manager (#56)
          </h3>
          <p style={{ color: "var(--foreground-default)", fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>
            Calls draw from a unified rate budget protecting both node RPC quotas and per-client budgets.
            Exhaustion triggers <code style={{ color: "var(--status-danger)" }}>429 Too Many Requests</code> with a standard
            <code style={{ color: "var(--status-warning)" }}>Retry-After</code> header, serving stale cache when safe.
          </p>
        </div>
      </div>

      {/* Interactive Swagger UI Container */}
      <div
        style={{
          background: "var(--surface-raised)",
          borderRadius: "8px",
          padding: "1.5rem",
          boxShadow: "0 4px 6px -1px var(--shadow-card), 0 2px 4px -1px var(--shadow-card)",
        }}
      >
        <div id="swagger-ui">
          {!swaggerReady && (
            <p style={{ color: "var(--foreground-muted)", textAlign: "center", padding: "2rem" }}>
              Loading interactive OpenAPI schema viewer...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
