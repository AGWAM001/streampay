import { Suspense } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StreamPayClient, type Stream } from "@streampay/sdk";
import { StreamPayProvider, useAccrual, useStream, useWithdraw } from "../src/index.js";

const contractId = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const networkPassphrase = "Test SDF Network ; September 2015";
let storyStream: Stream = {
  id: 1n,
  sender: "GSENDER",
  recipient: "GRECIPIENT",
  token: "CTOKEN",
  deposit: 1000n,
  withdrawn: 250n,
  startTime: 1n,
  endTime: 2n,
  cancelable: true,
  status: "Active",
  useOracle: null,
};

class StoryClient extends StreamPayClient {
  constructor() {
    super({ contractId, networkPassphrase });
  }
  override async getStream(): Promise<Stream> {
    return storyStream;
  }
  override async available(): Promise<bigint> {
    return storyStream.deposit - storyStream.withdrawn;
  }
  override async withdrawMax(): Promise<bigint> {
    const amount = storyStream.deposit - storyStream.withdrawn;
    storyStream = { ...storyStream, withdrawn: storyStream.deposit, status: "Depleted" };
    return amount;
  }
}

function StreamExample() {
  const stream = useStream(1n);
  const accrual = useAccrual(1n, { pollIntervalMs: 0 });
  const withdrawal = useWithdraw(1n);
  return (
    <section style={{ fontFamily: "sans-serif", maxWidth: 420, padding: 24 }}>
      <h2>Stream #{String(stream.id)}</h2>
      <dl>
        <dt>Status</dt><dd>{stream.status}</dd>
        <dt>Withdrawn</dt><dd>{String(stream.withdrawn)}</dd>
        <dt>Available</dt><dd>{String(accrual.amount)}</dd>
      </dl>
      <button disabled={withdrawal.pending} onClick={() => void withdrawal.withdrawMax().catch(() => undefined)}>
        {withdrawal.pending ? "Withdrawing…" : "Withdraw all"}
      </button>
      {withdrawal.error && <p role="alert">{withdrawal.error.message}</p>}
    </section>
  );
}

const meta = {
  title: "React/Stream example",
  component: StreamExample,
  parameters: { layout: "centered" },
} satisfies Meta<typeof StreamExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    storyStream = {
      id: 1n,
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "CTOKEN",
      deposit: 1000n,
      withdrawn: 250n,
      startTime: 1n,
      endTime: 2n,
      cancelable: true,
      status: "Active",
      useOracle: null,
    };
    return (
      <StreamPayProvider client={new StoryClient()}>
        <Suspense fallback={<p>Loading stream…</p>}>
          <StreamExample />
        </Suspense>
      </StreamPayProvider>
    );
  },
};
