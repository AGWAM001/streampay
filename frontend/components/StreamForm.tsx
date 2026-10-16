"use client";

import { useState } from "react";
import type { StreamArgs } from "@/lib/stream-types";

export default function StreamForm({
  onCreate,
}: {
  onCreate: (args: StreamArgs) => Promise<void>;
}) {
  const [args, setArgs] = useState<StreamArgs>({
    token: "",
    recipient: "",
    deposit: "1000000000",
    days: "30",
    cancelable: true,
  });
  const [busy, setBusy] = useState(false);

  const set =
    (k: keyof StreamArgs) =>
    (
      e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
    ) =>
      setArgs((prev) => ({
        ...prev,
        [k]: k === "cancelable" ? (e.target as HTMLSelectElement).value === "yes" : e.target.value,
      }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onCreate(args);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Create a stream</h2>
      <div className="row">
        <div>
          <label htmlFor="token">Token contract id</label>
          <input
            id="token"
            type="text"
            required
            placeholder="C… (SAC id, e.g. USDC on testnet)"
            value={args.token}
            onChange={set("token")}
          />
        </div>
        <div>
          <label htmlFor="recipient">Recipient</label>
          <input
            id="recipient"
            type="text"
            required
            placeholder="G…"
            value={args.recipient}
            onChange={set("recipient")}
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label htmlFor="deposit">Deposit (smallest units)</label>
          <input
            id="deposit"
            type="number"
            min="1"
            required
            value={args.deposit}
            onChange={set("deposit")}
          />
        </div>
        <div>
          <label htmlFor="days">Duration (days)</label>
          <input
            id="days"
            type="number"
            min="0.001"
            step="any"
            required
            value={args.days}
            onChange={set("days")}
          />
        </div>
        <div>
          <label htmlFor="cancelable">Recipient may cancel?</label>
          <select id="cancelable" value={args.cancelable ? "yes" : "no"} onChange={set("cancelable")}>
            <option value="yes">Yes (cancelable)</option>
            <option value="no">No (sender-only)</option>
          </select>
        </div>
      </div>
      <p className="muted">
        Approve the contract as a spender for the deposit first — the UI will
        prompt Freighter for the approval transaction if needed.
      </p>
      <button type="submit" disabled={busy}>
        {busy ? "Streaming…" : "Create stream"}
      </button>
    </form>
  );
}
