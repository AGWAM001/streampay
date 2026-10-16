/**
 * Minimal Soroban integration for StreamPay.
 *
 * Flow for every mutating call: build the contract operation → simulate
 * (validity + resource estimate) → Freighter signs → send → poll until
 * inclusion, then decode the contract's return value. Read-only calls
 * simulate and decode the return value without signing.
 */
import {
  Address,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import type { StreamArgs } from "@/lib/stream-types";

export type { StreamArgs, StreamView } from "@/lib/stream-types";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "";

function contract(): Contract {
  if (!CONTRACT_ID) {
    throw new Error(
      "NEXT_PUBLIC_STREAMING_CONTRACT_ID is not set — deploy the contract and put its id in frontend/.env.local"
    );
  }
  return new Contract(CONTRACT_ID);
}

function scAddr(s: string) {
  return nativeToScVal(new Address(s), { type: "address" });
}

function u64(id: string | number | bigint) {
  return nativeToScVal(BigInt(id), { type: "u64" });
}

function i128(v: string) {
  return nativeToScVal(BigInt(v), { type: "i128" });
}

/**
 * Network label for localStorage keys — stream ids are per-network facts and
 * must never leak between testnet and publicnet caches.
 */
export const NETWORK_LABEL = NETWORK === Networks.PUBLIC ? "public" : "testnet";

/**
 * Builds, simulates, Freighter-signs, sends and polls a mutating contract
 * operation. Resolves with the contract method's decoded return value.
 */
async function send<T>(
  source: string,
  operation: xdr.Operation,
  decode: (v: xdr.ScVal) => T
): Promise<T> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  // 1. Simulate: catches contract errors early and assembles Soroban tx data.
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  const ready = rpc.assembleTransaction(tx, simulated).build();

  // 2. Sign with Freighter.
  const { signedTxXdr } = await signTransaction(ready.toXDR(), {
    networkPassphrase: NETWORK,
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK);

  // 3. Send and poll for inclusion.
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${JSON.stringify(res.resultXdr)}`);
    }
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successful = res as { returnValue: xdr.ScVal };
      return decode(successful.returnValue);
    }
    // PENDING / DUPLICATE / TRY_AGAIN_LATER — keep polling.
  }
  throw new Error("Timed out waiting for transaction inclusion");
}

export async function createStream(
  sender: string,
  args: StreamArgs
): Promise<bigint> {
  const start = Math.floor(Date.now() / 1000) + 1;
  const end = start + Math.ceil(Number(args.days) * 86_400);
  const op = contract().call(
    "create_stream",
    scAddr(sender),
    scAddr(args.recipient),
    scAddr(args.token),
    i128(args.deposit),
    u64(start),
    u64(end),
    nativeToScVal(args.cancelable)
  );
  // create_stream returns the new stream id (u64).
  return send(sender, op, (v) => BigInt(scValToNative(v) as bigint));
}

export async function withdrawFromStream(
  recipient: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    recipient,
    contract().call("withdraw", u64(streamId), i128(amount)),
    () => undefined
  );
}

/**
 * Claims the full accrued balance in one atomic call (`withdraw_max`),
 * returning the amount paid (smallest token units).
 */
export async function withdrawMaxFromStream(
  recipient: string,
  streamId: string
): Promise<bigint> {
  return send(
    recipient,
    contract().call("withdraw_max", u64(streamId)),
    (v) => BigInt(scValToNative(v) as bigint)
  );
}

export async function topUpStream(
  sender: string,
  streamId: string,
  amount: string
): Promise<void> {
  await send(
    sender,
    contract().call("top_up", u64(streamId), i128(amount)),
    () => undefined
  );
}

export async function cancelStream(
  caller: string,
  streamId: string
): Promise<void> {
  await send(
    caller,
    contract().call("cancel_stream", scAddr(caller), u64(streamId)),
    () => undefined
  );
}

export { describeError } from "@/lib/errors";

