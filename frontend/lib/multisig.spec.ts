import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { isContractAddress, toMultisigView } from "./multisig";

const STREAMING = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 2));
const MULTISIG = StrKey.encodeContract(Buffer.alloc(32, 3));
const ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));

const key = (b: number) => Buffer.alloc(32, b);

describe("isContractAddress", () => {
  it("accepts C… contract ids only", () => {
    expect(isContractAddress(MULTISIG)).toBe(true);
    expect(isContractAddress(` ${MULTISIG} `)).toBe(true);
    expect(isContractAddress(ACCOUNT)).toBe(false);
    expect(isContractAddress("")).toBe(false);
    expect(isContractAddress(MULTISIG.slice(0, -1) + "A")).toBe(false);
  });
});

describe("toMultisigView", () => {
  it("reads threshold and signer count", () => {
    const raw = { signers: [key(1), key(2), key(3)], threshold: 2, epoch: 0, policies: [] };
    expect(toMultisigView(raw, STREAMING)).toEqual({
      threshold: 2,
      signers: 3,
      cancelThreshold: null,
    });
  });

  it("picks up a cancel_stream policy on the streaming contract only", () => {
    const raw = {
      signers: [key(1), key(2), key(3)],
      threshold: 2,
      epoch: 4,
      policies: [
        { contract: OTHER, func: "cancel_stream", threshold: 3 },
        { contract: STREAMING, func: "top_up", threshold: 3 },
        { contract: STREAMING, func: "cancel_stream", threshold: 1 },
      ],
    };
    expect(toMultisigView(raw, STREAMING)?.cancelThreshold).toBe(1);
  });

  it("rejects values that are not a multisig config", () => {
    expect(toMultisigView(null, STREAMING)).toBeNull();
    expect(toMultisigView(42, STREAMING)).toBeNull();
    expect(toMultisigView({ threshold: 1 }, STREAMING)).toBeNull();
    expect(toMultisigView({ signers: [key(1)], threshold: 2 }, STREAMING)).toBeNull();
    expect(toMultisigView({ signers: [key(1)], threshold: 0 }, STREAMING)).toBeNull();
  });
});
