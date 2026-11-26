/**
 * Passkey recovery, multi-device credential management, and contract-guard
 * helpers for StreamPay — Issue #603.
 *
 * Security invariants:
 * - No secret material (private keys, seeds, raw PINs) ever leaves the
 *   authenticator or is stored in browser storage.
 * - Client-side checks mirror the Soroban `passkey-signer` contract's
 *   sign-count monotonicity and challenge-expiry guards; they can only fail
 *   early for better UX and NEVER weaken or bypass the on-chain contract gate.
 */

export type AuthenticatorAttachmentMode = "platform" | "cross-platform";

export interface PasskeyCredentialInfo {
  id: string;
  deviceLabel: string;
  attachment: AuthenticatorAttachmentMode;
  createdAt: number;
  lastUsedAt: number | null;
  signCount: number;
  requireUV: boolean;
  status: "active" | "revoked";
}

export interface WebAuthnSupportStatus {
  supported: boolean;
  platformAvailable: boolean;
  roamingAvailable: boolean;
  reason?: string;
}

export interface WebAuthnMappedError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface GuardValidationResult {
  valid: boolean;
  reason?: string;
}

export interface RecoveryDecision {
  allowed: boolean;
  mode: "existing-credential" | "governance-recovery" | "blocked";
  activeCount: number;
  reason: string;
}

export interface PasskeyContractTransport {
  listCredentials: (owner: string) => Promise<PasskeyCredentialInfo[]>;
  registerDevice: (params: {
    owner: string;
    id: string;
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    xHex: string;
    yHex: string;
    rpIdHashHex: string;
    requireUV: boolean;
  }) => Promise<{ txHash: string }>;
  revokeDevice: (params: {
    owner: string;
    id: string;
    allowLast: boolean;
  }) => Promise<{ txHash: string }>;
  recoverDevice: (params: {
    owner: string;
    newId: string;
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    xHex: string;
    yHex: string;
    rpIdHashHex: string;
    requireUV: boolean;
    governanceApproved: boolean;
  }) => Promise<{ txHash: string }>;
  verifyAndRecordWithGuards: (params: {
    owner: string;
    credId: string;
    authData: Uint8Array;
    clientDataJson: Uint8Array;
    challenge: Uint8Array;
    challengeExpiresAtSec: number;
    sigR: Uint8Array;
    sigS: Uint8Array;
  }) => Promise<{ txHash: string }>;
}

export interface WebAuthnBoundary {
  createCredential: (options: CredentialCreationOptions) => Promise<PublicKeyCredential | null>;
  getAssertion: (options: CredentialRequestOptions) => Promise<PublicKeyCredential | null>;
}

/**
 * Detects browser WebAuthn and platform/roaming authenticator availability.
 */
export async function detectWebAuthnSupport(env?: {
  hasNavigator?: boolean;
  hasCredentials?: boolean;
  hasPublicKeyCredential?: boolean;
  isPlatformAvailable?: () => Promise<boolean>;
}): Promise<WebAuthnSupportStatus> {
  const hasNav = env?.hasNavigator ?? typeof navigator !== "undefined";
  const hasCreds =
    env?.hasCredentials ?? (hasNav && typeof navigator !== "undefined" && !!navigator.credentials);
  const hasPkc =
    env?.hasPublicKeyCredential ?? typeof PublicKeyCredential !== "undefined";

  if (!hasNav || !hasCreds || !hasPkc) {
    return {
      supported: false,
      platformAvailable: false,
      roamingAvailable: false,
      reason:
        "WebAuthn is not supported in this browser. Use a modern browser or connect with Freighter.",
    };
  }

  let platformAvailable = false;
  try {
    if (env?.isPlatformAvailable) {
      platformAvailable = await env.isPlatformAvailable();
    } else if (
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      platformAvailable =
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
  } catch {
    platformAvailable = false;
  }

  return {
    supported: true,
    platformAvailable,
    roamingAvailable: true,
    reason: platformAvailable
      ? undefined
      : "No built-in platform authenticator detected; roaming USB/NFC security keys remain available.",
  };
}

/**
 * Translates raw WebAuthn DOMExceptions and errors into user-friendly,
 * actionable messages without leaking internal state.
 */
export function mapWebAuthnError(err: unknown): WebAuthnMappedError {
  if (err && typeof err === "object" && "name" in err) {
    const name = String((err as { name: unknown }).name);
    switch (name) {
      case "NotAllowedError":
        return {
          code: "USER_CANCELLED_OR_TIMEOUT",
          message:
            "Authenticator prompt was cancelled or timed out. Confirm your device prompt to continue.",
          recoverable: true,
        };
      case "InvalidStateError":
        return {
          code: "ALREADY_REGISTERED",
          message:
            "This authenticator already holds a credential for this account. Choose a different device or revoke the existing one first.",
          recoverable: true,
        };
      case "NotSupportedError":
        return {
          code: "UNSUPPORTED_AUTHENTICATOR",
          message:
            "The selected authenticator type is not supported on this device. Try switching between Platform and Roaming key.",
          recoverable: true,
        };
      case "SecurityError":
        return {
          code: "ORIGIN_MISMATCH",
          message:
            "Security origin mismatch: passkeys require HTTPS and a matching Relying Party domain.",
          recoverable: false,
        };
      case "AbortError":
        return {
          code: "ABORTED",
          message: "Passkey operation was aborted before completion.",
          recoverable: true,
        };
      default:
        break;
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  return {
    code: "WEBAUTHN_ERROR",
    message: msg || "Passkey operation failed.",
    recoverable: true,
  };
}

/**
 * Reads the 4-byte big-endian WebAuthn signCount from `authData[33..37]`.
 */
export function extractSignCountFromAuthData(authData: Uint8Array): number {
  if (authData.length < 37) {
    throw new Error("authData must be at least 37 bytes to read signCount");
  }
  return (
    ((authData[33] << 24) |
      (authData[34] << 16) |
      (authData[35] << 8) |
      authData[36]) >>>
    0
  );
}

/**
 * Client-side mirror of `passkey-signer`'s sign-count monotonicity guard.
 * When a credential already has `previousSignCount > 0`, the new assertion's
 * `nextSignCount` must be strictly greater.
 */
export function validateSignCountMonotonicity(
  previousSignCount: number,
  nextSignCount: number
): GuardValidationResult {
  if (previousSignCount < 0 || nextSignCount < 0) {
    return { valid: false, reason: "Sign-count values cannot be negative." };
  }
  if (previousSignCount > 0 && nextSignCount <= previousSignCount) {
    return {
      valid: false,
      reason: `SignCountRegression: assertion counter (${nextSignCount}) did not advance past stored counter (${previousSignCount}).`,
    };
  }
  return { valid: true };
}

/**
 * Client-side mirror of `passkey-signer`'s challenge-expiry guard.
 */
export function validateChallengeFreshness(
  expiresAtSec: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): GuardValidationResult {
  if (nowSec > expiresAtSec) {
    return {
      valid: false,
      reason: "ChallengeExpired: authentication challenge expired before submission.",
    };
  }
  return { valid: true };
}

/**
 * Evaluates the recovery decision tree for an account.
 */
export function evaluateRecoveryPath(
  credentials: PasskeyCredentialInfo[],
  governanceApproved: boolean
): RecoveryDecision {
  const activeCount = credentials.filter((c) => c.status === "active").length;

  if (activeCount >= 1) {
    return {
      allowed: true,
      mode: "existing-credential",
      activeCount,
      reason: `${activeCount} active credential(s) remain. Authenticate with a remaining device to bind a replacement passkey.`,
    };
  }

  if (governanceApproved) {
    return {
      allowed: true,
      mode: "governance-recovery",
      activeCount: 0,
      reason:
        "Zero active credentials remain; governance recovery approval is present to re-bind a new device.",
    };
  }

  return {
    allowed: false,
    mode: "blocked",
    activeCount: 0,
    reason:
      "Recovery blocked: no active credentials remain and governance approval has not been granted. Contract guards cannot be bypassed.",
  };
}

/**
 * Registers a new authenticator (platform or roaming security key) with device label.
 */
export async function registerAdditionalPasskey(
  owner: string,
  input: {
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    requireUV?: boolean;
    rpId?: string;
    nowSec?: number;
  },
  deps: {
    webauthn?: WebAuthnBoundary;
    transport: PasskeyContractTransport;
    extractPublicKey?: (cred: PublicKeyCredential) => Promise<{
      id: string;
      xHex: string;
      yHex: string;
      rpIdHashHex: string;
    }>;
  }
): Promise<PasskeyCredentialInfo> {
  if (!owner.trim()) {
    throw new Error("Stellar address is required.");
  }
  if (!input.deviceLabel.trim()) {
    throw new Error("Device label is required.");
  }

  const boundary: WebAuthnBoundary = deps.webauthn ?? {
    createCredential: (opts) =>
      navigator.credentials.create(opts) as Promise<PublicKeyCredential | null>,
    getAssertion: (opts) =>
      navigator.credentials.get(opts) as Promise<PublicKeyCredential | null>,
  };

  const userId = crypto.getRandomValues(new Uint8Array(32));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = input.rpId ?? "streampay.app";

  let cred: PublicKeyCredential | null;
  try {
    cred = await boundary.createCredential({
      publicKey: {
        rp: { id: rpId, name: "StreamPay" },
        user: { id: userId, name: owner, displayName: input.deviceLabel.trim() },
        challenge,
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: input.attachment,
          userVerification: input.requireUV ? "required" : "preferred",
          residentKey: input.attachment === "platform" ? "required" : "preferred",
        },
        timeout: 60_000,
        attestation: "none",
      },
    });
  } catch (err) {
    const mapped = mapWebAuthnError(err);
    throw new Error(mapped.message);
  }

  if (!cred) {
    throw new Error(mapWebAuthnError({ name: "NotAllowedError" }).message);
  }

  if (!deps.extractPublicKey) {
    throw new Error("extractPublicKey helper is required");
  }
  const { id, xHex, yHex, rpIdHashHex } = await deps.extractPublicKey(cred);

  await deps.transport.registerDevice({
    owner: owner.trim(),
    id,
    deviceLabel: input.deviceLabel.trim(),
    attachment: input.attachment,
    xHex,
    yHex,
    rpIdHashHex,
    requireUV: Boolean(input.requireUV),
  });

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    id,
    deviceLabel: input.deviceLabel.trim(),
    attachment: input.attachment,
    createdAt: nowSec,
    lastUsedAt: null,
    signCount: 0,
    requireUV: Boolean(input.requireUV),
    status: "active",
  };
}

/**
 * Revokes an existing credential after explicit user confirmation.
 */
export async function revokePasskeyCredential(
  owner: string,
  credId: string,
  options: { confirmed: boolean; allowLast?: boolean },
  transport: PasskeyContractTransport
): Promise<{ txHash: string }> {
  if (!options.confirmed) {
    throw new Error("Explicit confirmation is required before revoking a passkey.");
  }
  return transport.revokeDevice({
    owner: owner.trim(),
    id: credId,
    allowLast: Boolean(options.allowLast),
  });
}

/**
 * Executes passkey recovery when allowed by the contract's recovery policy.
 */
export async function recoverPasskeyAccess(
  owner: string,
  input: {
    deviceLabel: string;
    attachment: AuthenticatorAttachmentMode;
    requireUV?: boolean;
    governanceApproved?: boolean;
    existingCredentials: PasskeyCredentialInfo[];
    rpId?: string;
    nowSec?: number;
  },
  deps: {
    webauthn?: WebAuthnBoundary;
    transport: PasskeyContractTransport;
    extractPublicKey: (cred: PublicKeyCredential) => Promise<{
      id: string;
      xHex: string;
      yHex: string;
      rpIdHashHex: string;
    }>;
  }
): Promise<PasskeyCredentialInfo> {
  const decision = evaluateRecoveryPath(
    input.existingCredentials,
    Boolean(input.governanceApproved)
  );
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
  if (!input.deviceLabel.trim()) {
    throw new Error("Replacement device label is required.");
  }

  const boundary: WebAuthnBoundary = deps.webauthn ?? {
    createCredential: (opts) =>
      navigator.credentials.create(opts) as Promise<PublicKeyCredential | null>,
    getAssertion: (opts) =>
      navigator.credentials.get(opts) as Promise<PublicKeyCredential | null>,
  };

  const userId = crypto.getRandomValues(new Uint8Array(32));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = input.rpId ?? "streampay.app";

  let cred: PublicKeyCredential | null;
  try {
    cred = await boundary.createCredential({
      publicKey: {
        rp: { id: rpId, name: "StreamPay" },
        user: { id: userId, name: owner, displayName: input.deviceLabel.trim() },
        challenge,
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: input.attachment,
          userVerification: input.requireUV ? "required" : "preferred",
          residentKey: input.attachment === "platform" ? "required" : "preferred",
        },
        timeout: 60_000,
        attestation: "none",
      },
    });
  } catch (err) {
    throw new Error(mapWebAuthnError(err).message);
  }

  if (!cred) {
    throw new Error(mapWebAuthnError({ name: "NotAllowedError" }).message);
  }

  const { id, xHex, yHex, rpIdHashHex } = await deps.extractPublicKey(cred);

  await deps.transport.recoverDevice({
    owner: owner.trim(),
    newId: id,
    deviceLabel: input.deviceLabel.trim(),
    attachment: input.attachment,
    xHex,
    yHex,
    rpIdHashHex,
    requireUV: Boolean(input.requireUV),
    governanceApproved: decision.mode === "governance-recovery",
  });

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    id,
    deviceLabel: input.deviceLabel.trim(),
    attachment: input.attachment,
    createdAt: nowSec,
    lastUsedAt: null,
    signCount: 0,
    requireUV: Boolean(input.requireUV),
    status: "active",
  };
}

/**
 * Submits an assertion through the contract's guarded verification gate,
 * enforcing challenge freshness and sign-count monotonicity before and on-chain.
 */
export async function verifyAssertionWithGuards(
  owner: string,
  cred: PasskeyCredentialInfo,
  params: {
    authData: Uint8Array;
    clientDataJson: Uint8Array;
    challenge: Uint8Array;
    challengeExpiresAtSec: number;
    sigR: Uint8Array;
    sigS: Uint8Array;
    nowSec?: number;
  },
  transport: PasskeyContractTransport
): Promise<{ txHash: string; nextSignCount: number }> {
  const freshness = validateChallengeFreshness(
    params.challengeExpiresAtSec,
    params.nowSec
  );
  if (!freshness.valid) {
    throw new Error(freshness.reason);
  }

  const nextSignCount = extractSignCountFromAuthData(params.authData);
  const monotonic = validateSignCountMonotonicity(cred.signCount, nextSignCount);
  if (!monotonic.valid) {
    throw new Error(monotonic.reason);
  }

  const { txHash } = await transport.verifyAndRecordWithGuards({
    owner: owner.trim(),
    credId: cred.id,
    authData: params.authData,
    clientDataJson: params.clientDataJson,
    challenge: params.challenge,
    challengeExpiresAtSec: params.challengeExpiresAtSec,
    sigR: params.sigR,
    sigS: params.sigS,
  });

  return { txHash, nextSignCount };
}

