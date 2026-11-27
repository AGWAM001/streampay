/** Multi-region canary quorum. A page fires only when M of N probes fail together. */

export const DEFAULT_QUORUM = Object.freeze({
  regions: ["us-east", "eu-west", "ap-southeast"],
  threshold: 2,
  windowMs: 60_000,
  escalationAfter: 2,
});

export function probeDigest(result) {
  return [
    result.region,
    result.nonce,
    result.observedAt,
    result.ok ? "ok" : "fail",
    result.sequence,
  ].join("|");
}

export function signProbe(result, secret) {
  const digest = probeDigest(result);
  let hash = 0;
  const material = `${secret}:${digest}`;
  for (let index = 0; index < material.length; index += 1) {
    hash = (hash * 33 + material.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function verifyProbe(result, secret, seen) {
  if (!result || typeof result.region !== "string" || typeof result.nonce !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (result.signature !== signProbe(result, secret)) {
    return { ok: false, reason: "bad-signature" };
  }
  const replayKey = `${result.region}:${result.nonce}`;
  if (seen.has(replayKey)) {
    return { ok: false, reason: "replay" };
  }
  seen.add(replayKey);
  return { ok: true };
}

/**
 * @param {Array<{region: string, ok: boolean, observedAt: number, signature?: string, nonce?: string}>} reports
 * @param {{regions: string[], threshold: number, windowMs: number, escalationAfter?: number}} policy
 * @param {number} now
 * @param {{consecutiveFailures?: number}} state
 */
export function evaluateQuorum(reports, policy, now, state = {}) {
  const fresh = reports.filter((report) => now - report.observedAt <= policy.windowMs);
  const byRegion = new Map();
  for (const report of fresh) {
    const current = byRegion.get(report.region);
    if (!current || report.observedAt >= current.observedAt) {
      byRegion.set(report.region, report);
    }
  }
  const considered = policy.regions.map((region) => byRegion.get(region) ?? null);
  const present = considered.filter((report) => report != null);
  const failures = present.filter((report) => report.ok === false);
  const successes = present.filter((report) => report.ok === true);
  const missing = policy.regions.length - present.length;
  const quorumFailure = failures.length >= policy.threshold;
  const quorumSuccess = successes.length >= policy.threshold && failures.length === 0;
  const consecutiveFailures = quorumFailure ? (state.consecutiveFailures ?? 0) + 1 : 0;
  let action = "suppress";
  if (quorumFailure && consecutiveFailures >= (policy.escalationAfter ?? 2)) {
    action = "escalate";
  } else if (quorumFailure) {
    action = "page";
  } else if (quorumSuccess) {
    action = "recover";
  }
  return {
    action,
    failures: failures.length,
    successes: successes.length,
    missing,
    consecutiveFailures,
    suppressed: failures.length > 0 && !quorumFailure,
  };
}
