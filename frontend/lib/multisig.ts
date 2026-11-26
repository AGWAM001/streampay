/**
 * Multisig detection for the create-stream form (issue #50).
 *
 * A StreamPay sender or recipient can be a K-of-N multisig: a contract
 * (`C…`) address running the reference `contracts/multisig` account. The
 * streaming contract does not special-case it; the form only *explains* what
 * the address will need, by reading the multisig's `config()` view. Any other
 * contract (or an RPC failure) reads as `null`, and the form falls back to a
 * generic "contract address" note.
 *
 * Pure helpers only — the RPC read lives in `lib/stellar-read.ts`
 * (`readMultisigConfig`), behind the `readMultisigConfigAction` server action.
 */

import { StrKey } from "@stellar/stellar-sdk";

/** What the form shows about a multisig address. */
export interface MultisigView {
  /** Default number of signatures every action needs. */
  threshold: number;
  /** Size of the signer set. */
  signers: number;
  /**
   * Signatures `cancel_stream` on the configured streaming contract needs,
   * when the multisig sets a per-function policy for it; otherwise `null`
   * (cancel then needs `threshold`).
   */
  cancelThreshold: number | null;
}

/** True for a checksum-valid contract (`C…`) address. */
export function isContractAddress(value: string): boolean {
  return StrKey.isValidContract(value.trim());
}

interface RawPolicy {
  contract?: unknown;
  func?: unknown;
  threshold?: unknown;
}

/**
 * Maps the `scValToNative` form of the multisig's `Config` to a view, or
 * `null` when the value is not shaped like one (a different contract that
 * happens to expose a `config` function).
 */
export function toMultisigView(
  raw: unknown,
  streamingContractId: string
): MultisigView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.signers)) return null;
  const threshold = Number(r.threshold);
  const signers = r.signers.length;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > signers) {
    return null;
  }
  let cancelThreshold: number | null = null;
  if (Array.isArray(r.policies)) {
    for (const p of r.policies as RawPolicy[]) {
      if (
        String(p.contract) === streamingContractId &&
        String(p.func) === "cancel_stream"
      ) {
        cancelThreshold = Number(p.threshold);
      }
    }
  }
  return { threshold, signers, cancelThreshold };
}
