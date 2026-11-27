import React, { useState } from 'react';

export interface AmendmentPanelProps {
  streamId: string;
  currentRate: string;
  currentEndTime: string;
  onApplyAmendment: (newRate: string, newEndTime: string) => void;
  onPartialCancel: (newEndTime: string) => void;
}

export const AmendmentPanel: React.FC<AmendmentPanelProps> = ({
  streamId,
  currentRate,
  currentEndTime,
  onApplyAmendment,
  onPartialCancel,
}) => {
  const [newRate, setNewRate] = useState(currentRate);
  const [newEndTime, setNewEndTime] = useState(currentEndTime);

  return (
    <div className="bg-[var(--surface-raised)] shadow-[var(--shadow-card)] rounded-lg p-6 max-w-lg mx-auto">
      <h3 className="text-lg font-medium text-[var(--foreground-default)] mb-4">Stream Amendment & Partial Cancel (Stream #{streamId})</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--foreground-default)]">New Rate (per second)</label>
          <input
            type="text"
            value={newRate}
            onChange={(e) => setNewRate(e.target.value)}
            className="mt-1 block w-full border rounded-md shadow-[var(--shadow-card)] p-2 text-sm font-mono"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--foreground-default)]">New End Time (Timestamp)</label>
          <input
            type="text"
            value={newEndTime}
            onChange={(e) => setNewEndTime(e.target.value)}
            className="mt-1 block w-full border rounded-md shadow-[var(--shadow-card)] p-2 text-sm font-mono"
          />
        </div>
        <div className="flex gap-4">
          <button
            onClick={() => onApplyAmendment(newRate, newEndTime)}
            className="flex-1 bg-[var(--accent-strong)] text-[var(--foreground-on-accent)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent-strong-hover)]"
          >
            Apply Rate & End Amendment
          </button>
          <button
            onClick={() => onPartialCancel(newEndTime)}
            className="flex-1 bg-[var(--status-danger-button)] text-[var(--foreground-on-danger)] px-4 py-2 rounded-md text-sm hover:bg-[var(--status-danger-button-end)]"
          >
            Partial Cancel & Refund Surplus
          </button>
        </div>
      </div>
    </div>
  );
};
