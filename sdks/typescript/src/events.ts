import { xdr } from "@stellar/stellar-sdk";
import { decodeStreamPayEvent, type StreamPayEvent } from "./generated.js";
import { decodeError } from "./errors.js";

/** Decodes one RPC event, optionally rejecting contracts other than `expectedContractId`. */
export function decodeEvent(event: xdr.ContractEvent, expectedContractId?: string): StreamPayEvent | null {
  return decodeStreamPayEvent(event, expectedContractId);
}

/** Decodes one base64 `ContractEvent` XDR (RPC `getEvents().valueXdr`). */
export function decodeEventXdr(base64: string, expectedContractId?: string): StreamPayEvent | null {
  try {
    return decodeEvent(xdr.ContractEvent.fromXDR(base64, "base64"), expectedContractId);
  } catch (error) {
    throw decodeError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Decodes a batch of events, dropping foreign contracts. A malformed event
 * fails the batch instead of being silently skipped: indexers need to know
 * when their feed is corrupt.
 */
export function decodeEvents(base64: readonly string[], expectedContractId?: string): StreamPayEvent[] {
  const decoded: StreamPayEvent[] = [];
  for (const encoded of base64) {
    const event = decodeEventXdr(encoded, expectedContractId);
    if (event !== null) decoded.push(event);
  }
  return decoded;
}
