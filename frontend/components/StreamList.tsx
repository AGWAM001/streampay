import React from 'react';

export interface StreamItem {
  id: string;
  recipient: string;
  balance: string;
  refillRule?: {
    amount: string;
    cadenceSeconds: number;
    lastRefillTimestamp: number;
    maxTopups: number;
    topupsExecuted: number;
  };
}

export const StreamList: React.FC<{ streams: StreamItem[] }> = ({ streams }) => {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stream ID</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recipient</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Balance</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Refill Status / Next Eligible</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {streams.map((stream) => {
            const rule = stream.refillRule;
            const nextEligible = rule 
              ? new Date((rule.lastRefillTimestamp + rule.cadenceSeconds) * 1000).toLocaleString() 
              : 'No Refill Rule';

            return (
              <tr key={stream.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-mono">{stream.id}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{stream.recipient}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stream.balance}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-indigo-600 font-medium">
                  {rule ? `${rule.topupsExecuted}/${rule.maxTopups} top-ups | Next: ${nextEligible}` : 'None'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
