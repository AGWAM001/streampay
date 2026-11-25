import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  detectWebAuthnSupport,
  evaluateRecoveryPath,
  extractSignCountFromAuthData,
  mapWebAuthnError,
  recoverPasskeyAccess,
  registerAdditionalPasskey,
  revokePasskeyCredential,
  validateChallengeFreshness,
  validateSignCountMonotonicity,
  verifyAssertionWithGuards,
  type PasskeyContractTransport,
  type PasskeyCredentialInfo,
} from "./passkey-manager.ts";

function makeCredential(
  overrides: Partial<PasskeyCredentialInfo> = {}
): PasskeyCredentialInfo {
  return {
    id: "aa".repeat(32),
    deviceLabel: "MacBook Touch ID",
    attachment: "platform",
    createdAt: 1700000000,
    lastUsedAt: 1700000100,
    signCount: 5,
    requireUV: true,
    status: "active",
    ...overrides,
  };
}

function makeMockTransport(
  initial: PasskeyCredentialInfo[] = []
): PasskeyContractTransport & {
  credentials: PasskeyCredentialInfo[];
  calls: string[];
} {
  const credentials = [...initial];
  const calls: string[] = [];
  return {
    credentials,
    calls,
    async listCredentials() {
      calls.push("listCredentials");
      return [...credentials];
    },
    async registerDevice(params) {
      calls.push(`registerDevice:${params.attachment}:${params.deviceLabel}`);
      credentials.push({
        id: params.id,
        deviceLabel: params.deviceLabel,
        attachment: params.attachment,
        createdAt: 1700000200,
        lastUsedAt: null,
        signCount: 0,
        requireUV: params.requireUV,
        status: "active",
      });
      return { txHash: "tx-register-1" };
    },
    async revokeDevice(params) {
      calls.push(`revokeDevice:${params.id}:${params.allowLast}`);
      const active = credentials.filter((c) => c.status === "active");
      if (active.length <= 1 && !params.allowLast) {
        throw new Error("LastCredentialProtected");
      }
      const target = credentials.find((c) => c.id === params.id);
      if (!target) throw new Error("CredentialNotFound");
      target.status = "revoked";
      return { txHash: "tx-revoke-1" };
    },
    async recoverDevice(params) {
      calls.push(`recoverDevice:${params.governanceApproved}:${params.deviceLabel}`);
      const active = credentials.filter((c) => c.status === "active");
      if (active.length === 0 && !params.governanceApproved) {
        throw new Error("RecoveryNotAuthorized");
      }
      credentials.push({
        id: params.newId,
        deviceLabel: params.deviceLabel,
        attachment: params.attachment,
        createdAt: 1700000300,
        lastUsedAt: null,
        signCount: 0,
        requireUV: params.requireUV,
        status: "active",
      });
      return { txHash: "tx-recover-1" };
    },
    async verifyAndRecordWithGuards(params) {
      calls.push(`verifyAndRecordWithGuards:${params.credId}`);
      const target = credentials.find((c) => c.id === params.credId && c.status === "active");
      if (!target) throw new Error("CredentialNotFound");
      const nowSec = 1700000500;
      if (nowSec > params.challengeExpiresAtSec) {
        throw new Error("ChallengeExpired");
      }
      const nextCount = extractSignCountFromAuthData(params.authData);
      if (target.signCount > 0 && nextCount <= target.signCount) {
        throw new Error("SignCountRegression");
      }
      target.signCount = nextCount;
      target.lastUsedAt = nowSec;
      return { txHash: "tx-verify-1" };
    },
  };
}

function makeAuthDataWithSignCount(signCount: number): Uint8Array {
  const buf = new Uint8Array(37);
  buf[32] = 0x05; // UP + UV
  buf[33] = (signCount >>> 24) & 0xff;
  buf[34] = (signCount >>> 16) & 0xff;
  buf[35] = (signCount >>> 8) & 0xff;
  buf[36] = signCount & 0xff;
  return buf;
}

describe("Issue #603 — Passkey recovery, multi-device UX & contract guards", () => {
  test("detectWebAuthnSupport handles unsupported browsers and platform-vs-roaming gracefully", async () => {
    const unsupported = await detectWebAuthnSupport({
      hasNavigator: false,
      hasCredentials: false,
      hasPublicKeyCredential: false,
    });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.platformAvailable, false);
    assert.equal(unsupported.roamingAvailable, false);
    assert.match(unsupported.reason ?? "", /not supported/i);

    const roamingOnly = await detectWebAuthnSupport({
      hasNavigator: true,
      hasCredentials: true,
      hasPublicKeyCredential: true,
      isPlatformAvailable: async () => false,
    });
    assert.equal(roamingOnly.supported, true);
    assert.equal(roamingOnly.platformAvailable, false);
    assert.equal(roamingOnly.roamingAvailable, true);
    assert.match(roamingOnly.reason ?? "", /roaming/i);

    const full = await detectWebAuthnSupport({
      hasNavigator: true,
      hasCredentials: true,
      hasPublicKeyCredential: true,
      isPlatformAvailable: async () => true,
    });
    assert.equal(full.supported, true);
    assert.equal(full.platformAvailable, true);
    assert.equal(full.roamingAvailable, true);
  });

  test("mapWebAuthnError maps cancellation, duplicate device, unsupported, and security errors", () => {
    assert.equal(mapWebAuthnError({ name: "NotAllowedError" }).code, "USER_CANCELLED_OR_TIMEOUT");
    assert.equal(mapWebAuthnError({ name: "InvalidStateError" }).code, "ALREADY_REGISTERED");
    assert.equal(mapWebAuthnError({ name: "NotSupportedError" }).code, "UNSUPPORTED_AUTHENTICATOR");
    const sec = mapWebAuthnError({ name: "SecurityError" });
    assert.equal(sec.code, "ORIGIN_MISMATCH");
    assert.equal(sec.recoverable, false);
  });

  test("registerAdditionalPasskey supports platform and roaming authenticators and handles WebAuthn cancellation", async () => {
    const transport = makeMockTransport();
    let attachmentObserved = "";

    const platformCred = await registerAdditionalPasskey(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      { deviceLabel: "iPhone Face ID", attachment: "platform", requireUV: true, nowSec: 1700000200 },
      {
        transport,
        webauthn: {
          createCredential: async (opts) => {
            attachmentObserved = opts.publicKey?.authenticatorSelection?.authenticatorAttachment ?? "";
            return { id: "cred-1" } as unknown as PublicKeyCredential;
          },
          getAssertion: async () => null,
        },
        extractPublicKey: async () => ({
          id: "11".repeat(32),
          xHex: "aa".repeat(32),
          yHex: "bb".repeat(32),
          rpIdHashHex: "cc".repeat(32),
        }),
      }
    );

    assert.equal(attachmentObserved, "platform");
    assert.equal(platformCred.deviceLabel, "iPhone Face ID");
    assert.equal(transport.credentials.length, 1);

    // Cancellation surfaces clean user-facing error
    await assert.rejects(
      () =>
        registerAdditionalPasskey(
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          { deviceLabel: "YubiKey 5C", attachment: "cross-platform" },
          {
            transport,
            webauthn: {
              createCredential: async () => {
                throw { name: "NotAllowedError" };
              },
              getAssertion: async () => null,
            },
            extractPublicKey: async () => ({
              id: "22".repeat(32),
              xHex: "aa".repeat(32),
              yHex: "bb".repeat(32),
              rpIdHashHex: "cc".repeat(32),
            }),
          }
        ),
      /cancelled or timed out/i
    );
  });

  test("revokePasskeyCredential requires explicit confirmation and enforces last-credential protection", async () => {
    const c1 = makeCredential({ id: "11".repeat(32), deviceLabel: "Primary" });
    const c2 = makeCredential({ id: "22".repeat(32), deviceLabel: "Backup" });
    const transport = makeMockTransport([c1, c2]);

    await assert.rejects(
      () => revokePasskeyCredential("GOWNER", c1.id, { confirmed: false }, transport),
      /explicit confirmation/i
    );

    await revokePasskeyCredential("GOWNER", c1.id, { confirmed: true }, transport);
    assert.equal(transport.credentials[0].status, "revoked");

    // Revoking last remaining active credential without allowLast fails at contract gate
    await assert.rejects(
      () => revokePasskeyCredential("GOWNER", c2.id, { confirmed: true, allowLast: false }, transport),
      /LastCredentialProtected/
    );

    await revokePasskeyCredential("GOWNER", c2.id, { confirmed: true, allowLast: true }, transport);
    assert.equal(transport.credentials[1].status, "revoked");
  });

  test("recovery decision tree allows remaining-credential or governance-approved recovery and blocks unauthorized", async () => {
    const active = makeCredential();
    assert.equal(evaluateRecoveryPath([active], false).mode, "existing-credential");
    assert.equal(evaluateRecoveryPath([], true).mode, "governance-recovery");
    assert.equal(evaluateRecoveryPath([], false).allowed, false);
    assert.equal(evaluateRecoveryPath([], false).mode, "blocked");

    const transport = makeMockTransport([]);
    await assert.rejects(
      () =>
        recoverPasskeyAccess(
          "GOWNER",
          {
            deviceLabel: "New Phone",
            attachment: "platform",
            existingCredentials: [],
            governanceApproved: false,
          },
          {
            transport,
            webauthn: {
              createCredential: async () => ({ id: "r" } as unknown as PublicKeyCredential),
              getAssertion: async () => null,
            },
            extractPublicKey: async () => ({
              id: "33".repeat(32),
              xHex: "aa".repeat(32),
              yHex: "bb".repeat(32),
              rpIdHashHex: "cc".repeat(32),
            }),
          }
        ),
      /Recovery blocked/i
    );

    const recovered = await recoverPasskeyAccess(
      "GOWNER",
      {
        deviceLabel: "Governance Backup Key",
        attachment: "cross-platform",
        existingCredentials: [],
        governanceApproved: true,
      },
      {
        transport,
        webauthn: {
          createCredential: async () => ({ id: "r2" } as unknown as PublicKeyCredential),
          getAssertion: async () => null,
        },
        extractPublicKey: async () => ({
          id: "44".repeat(32),
          xHex: "aa".repeat(32),
          yHex: "bb".repeat(32),
          rpIdHashHex: "cc".repeat(32),
        }),
      }
    );
    assert.equal(recovered.deviceLabel, "Governance Backup Key");
  });

  test("sign-count monotonicity and challenge-expiry guards block invalid assertions", async () => {
    assert.equal(validateSignCountMonotonicity(5, 5).valid, false);
    assert.equal(validateSignCountMonotonicity(5, 4).valid, false);
    assert.equal(validateSignCountMonotonicity(5, 6).valid, true);
    assert.equal(validateChallengeFreshness(1700000400, 1700000500).valid, false);
    assert.equal(validateChallengeFreshness(1700000600, 1700000500).valid, true);

    const cred = makeCredential({ signCount: 5 });
    const transport = makeMockTransport([cred]);

    // Expired challenge blocked before/at contract gate
    await assert.rejects(
      () =>
        verifyAssertionWithGuards(
          "GOWNER",
          cred,
          {
            authData: makeAuthDataWithSignCount(6),
            clientDataJson: new Uint8Array(10),
            challenge: new Uint8Array(32),
            challengeExpiresAtSec: 1700000400,
            sigR: new Uint8Array(32),
            sigS: new Uint8Array(32),
            nowSec: 1700000500,
          },
          transport
        ),
      /ChallengeExpired/
    );

    // Sign-count regression blocked
    await assert.rejects(
      () =>
        verifyAssertionWithGuards(
          "GOWNER",
          cred,
          {
            authData: makeAuthDataWithSignCount(5),
            clientDataJson: new Uint8Array(10),
            challenge: new Uint8Array(32),
            challengeExpiresAtSec: 1700000600,
            sigR: new Uint8Array(32),
            sigS: new Uint8Array(32),
            nowSec: 1700000500,
          },
          transport
        ),
      /SignCountRegression/
    );

    // Strictly advancing sign-count with fresh challenge succeeds
    const res = await verifyAssertionWithGuards(
      "GOWNER",
      cred,
      {
        authData: makeAuthDataWithSignCount(6),
        clientDataJson: new Uint8Array(10),
        challenge: new Uint8Array(32),
        challengeExpiresAtSec: 1700000600,
        sigR: new Uint8Array(32),
        sigS: new Uint8Array(32),
        nowSec: 1700000500,
      },
      transport
    );
    assert.equal(res.nextSignCount, 6);
    assert.equal(res.txHash, "tx-verify-1");
  });
});

